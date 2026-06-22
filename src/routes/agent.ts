import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { aiEnabled } from '../config/env';
import { authenticate, type AuthedAgent } from '../lib/auth';
import { metrics } from '../lib/metrics';
import { NotFoundError, UpstreamError, ValidationError, errorMessage } from '../lib/errors';
import { supabase } from '../lib/supabase';
import {
  isSubscribedToMessages,
  isWithinStandardWindow,
  sendMessage,
  subscribeToMessages,
} from '../services/instagram/client';
import { buildAuthorizeUrl, isOAuthConfigured } from '../services/instagram/oauth';
import { rememberState } from '../services/instagram/oauthState';
import { getStoredCredentials } from '../services/instagram/tokenStore';
import {
  getConversation,
  recordOutboundMessage,
  transitionStatus,
} from '../services/conversation/store';
import {
  createDocument,
  deleteDocument,
  ingestDocument,
  updateDocument,
} from '../services/rag/ingest';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AuthedAgent;
  }
}

const IdParam = z.object({ id: z.string().uuid() });
const ReplyBody = z.object({ text: z.string().trim().min(1).max(2000) });
const CreateDocBody = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1),
  sourceType: z.string().trim().max(50).optional(),
});
const UpdateDocBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().trim().min(1).optional(),
  })
  .refine((b) => b.title !== undefined || b.content !== undefined, {
    message: 'Provide a title or content to update',
  });

async function loadConversationOrThrow(id: string) {
  const conversation = await getConversation(id);
  if (!conversation) throw new NotFoundError('Conversation not found');
  return conversation;
}

async function customerIgId(customerId: string): Promise<string> {
  const { data, error } = await supabase
    .from('customers')
    .select('ig_user_id')
    .eq('id', customerId)
    .single();
  if (error || !data) throw new UpstreamError('failed to load customer', { cause: error });
  return (data as { ig_user_id: string }).ig_user_id;
}

async function countWebhookEvents(sinceIso?: string): Promise<number> {
  let query = supabase.from('webhook_events').select('id', { count: 'exact', head: true });
  if (sinceIso) query = query.gte('received_at', sinceIso);
  const { count, error } = await query;
  if (error) throw new UpstreamError('failed to count webhook events', { cause: error });
  return count ?? 0;
}

async function lastWebhookEvent(): Promise<{ received_at: string; error: string | null } | null> {
  const { data, error } = await supabase
    .from('webhook_events')
    .select('received_at, error')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new UpstreamError('failed to read webhook events', { cause: error });
  return (data as { received_at: string; error: string | null } | null) ?? null;
}

// All endpoints require a valid Supabase agent session, verified server-side.
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request) => {
    request.agent = await authenticate(request);
  });

  app.post('/conversations/:id/takeover', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const conversation = await transitionStatus({
      conversationId: id,
      to: 'human',
      reason: 'agent_takeover',
      agentId: request.agent!.agentId,
      assign: true,
    });
    return reply.send({ conversation });
  });

  app.post('/conversations/:id/handback', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const conversation = await transitionStatus({
      conversationId: id,
      to: 'bot',
      reason: 'agent_handback',
      agentId: null,
      assign: true,
    });
    return reply.send({ conversation });
  });

  app.post('/conversations/:id/close', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const conversation = await transitionStatus({
      conversationId: id,
      to: 'closed',
      reason: 'agent_close',
    });
    return reply.send({ conversation });
  });

  app.post('/conversations/:id/reply', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const { text } = ReplyBody.parse(request.body);
    const agentId = request.agent!.agentId;

    const conversation = await loadConversationOrThrow(id);
    const igUserId = await customerIgId(conversation.customer_id);

    // An agent replying owns the conversation: ensure it is in human state and
    // assigned to them so the bot stops and the inbox reflects ownership.
    if (conversation.status !== 'human' || conversation.assigned_agent_id !== agentId) {
      await transitionStatus({
        conversationId: id,
        to: 'human',
        reason: 'agent_reply',
        agentId,
        assign: true,
      });
    }

    // Outside the 24h window, a human reply must carry the human_agent tag.
    const tag = isWithinStandardWindow(conversation.last_customer_at) ? undefined : 'human_agent';

    try {
      const result = await sendMessage(igUserId, text, tag ? { tag } : {});
      const message = await recordOutboundMessage({
        conversationId: id,
        sender: 'agent',
        content: text,
        status: 'sent',
        igMessageId: result.messageId || undefined,
        metadata: { agentId },
      });
      return reply.send({ message });
    } catch (err) {
      await recordOutboundMessage({
        conversationId: id,
        sender: 'agent',
        content: text,
        status: 'failed',
        error: errorMessage(err),
        metadata: { agentId },
      });
      throw new UpstreamError('Failed to deliver message to Instagram', { cause: err });
    }
  });

  // Instagram connection — driven from the dashboard. The agent's session is the
  // gate, so no setup secret is needed here.
  app.get('/instagram/status', async (_request, reply) => {
    const creds = await getStoredCredentials();
    const connected = Boolean(creds);
    // Whether Instagram will actually deliver DMs to us. Connected-but-not-
    // subscribed is the common reason messages never arrive.
    const subscribedToMessages = connected ? await isSubscribedToMessages() : false;
    return reply.send({
      connected,
      igUserId: creds?.igUserId ?? null,
      tokenType: creds?.tokenType ?? null,
      expiresAt: creds?.expiresAt ?? null,
      subscribedToMessages,
    });
  });

  // Manually (re)subscribe the connected account to message webhooks.
  app.post('/instagram/subscribe', async (_request, reply) => {
    const subscribed = await subscribeToMessages();
    return reply.send({ subscribed });
  });

  // One-call health/diagnostic snapshot for the dashboard: is Instagram
  // connected + subscribed, is AI on, and crucially — are webhooks actually
  // arriving from Meta (and is processing erroring)?
  app.get('/diagnostics', async (_request, reply) => {
    const creds = await getStoredCredentials();
    const connected = Boolean(creds);
    const subscribedToMessages = connected ? await isSubscribedToMessages() : false;

    const total = await countWebhookEvents();
    const lastHour = await countWebhookEvents(new Date(Date.now() - 3_600_000).toISOString());
    const last = await lastWebhookEvent();

    return reply.send({
      instagram: { connected, subscribedToMessages, igUserId: creds?.igUserId ?? null },
      ai: { enabled: aiEnabled },
      webhooks: {
        total,
        lastHour,
        lastReceivedAt: last?.received_at ?? null,
        lastError: last?.error ?? null,
        signatureFailures: metrics.webhookSignatureFailures,
      },
    });
  });

  app.get('/instagram/connect-url', async (_request, reply) => {
    if (!isOAuthConfigured()) {
      return reply.code(500).send({
        error: 'oauth_not_configured',
        message: 'Set IG_APP_ID, IG_APP_SECRET, and IG_REDIRECT_URI on the server.',
      });
    }
    const state = crypto.randomUUID();
    rememberState(state);
    return reply.send({ url: buildAuthorizeUrl(state) });
  });

  app.post('/knowledge', async (request, reply) => {
    const body = CreateDocBody.parse(request.body);
    const result = await createDocument(body);
    return reply.code(201).send(result);
  });

  app.put('/knowledge/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const body = UpdateDocBody.parse(request.body);
    const result = await updateDocument(id, body);
    return reply.send(result);
  });

  app.delete('/knowledge/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    await deleteDocument(id);
    return reply.code(204).send();
  });

  // Force a re-embed from the stored raw content (e.g. after switching models).
  app.post('/knowledge/:id/reembed', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const { data, error } = await supabase
      .from('knowledge_documents')
      .select('raw_content')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new UpstreamError('failed to load document', { cause: error });
    if (!data) throw new NotFoundError('Document not found');
    if (!(data as { raw_content: string }).raw_content.trim()) {
      throw new ValidationError('Document has no content to embed');
    }

    const chunkCount = await ingestDocument(id, (data as { raw_content: string }).raw_content);
    return reply.send({ id, chunkCount });
  });
}
