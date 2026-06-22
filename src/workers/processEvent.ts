import { aiEnabled, env } from '../config/env';
import { errorMessage } from '../lib/errors';
import { logger } from '../lib/logger';
import { supabase } from '../lib/supabase';
import { getUserProfile, sendMessage } from '../services/instagram/client';
import { resolveInboundContent } from '../services/instagram/media';
import {
  getBotSettings,
  getOrCreateConversation,
  getRecentHistory,
  recordInboundMessage,
  recordOutboundMessage,
  transitionStatus,
  upsertCustomer,
} from '../services/conversation/store';
import { retrieve } from '../services/rag/retrieve';
import { generateAnswer } from '../services/rag/generate';
import { BRIDGING_MESSAGE, decideEscalation } from '../services/handover/escalate';
import type { WebhookMessageEvent } from '../types';

function nowIso(): string {
  return new Date().toISOString();
}

async function markProcessed(eventKey: string): Promise<void> {
  await supabase
    .from('webhook_events')
    .update({ processed: true, processed_at: nowIso() })
    .eq('event_key', eventKey);
}

async function markError(eventKey: string, message: string): Promise<void> {
  await supabase
    .from('webhook_events')
    .update({ error: message, processed_at: nowIso() })
    .eq('event_key', eventKey);
}

// Process a single inbound customer message end to end. This runs off the
// request path (enqueued after the webhook returns 200). It is the unit of
// failure isolation: any error is caught, logged with context, and recorded on
// the webhook_events row — it must never escape and disturb sibling events.
export async function processEvent(event: WebhookMessageEvent): Promise<void> {
  const { eventKey, inbound } = event;
  const log = logger.child({ eventKey, igMessageId: inbound.igMessageId });

  try {
    const settings = await getBotSettings();

    const customer = await upsertCustomer(inbound.senderId, () => getUserProfile(inbound.senderId));
    const { conversation, isNew } = await getOrCreateConversation(customer.id);

    // Resolve voice to text (transcribe) and collect image URLs for the vision
    // model so the bot understands more than plain text.
    const resolved = await resolveInboundContent(inbound);
    const recordedContent = resolved.imageUrls.length
      ? `${resolved.text}${resolved.text ? ' ' : ''}[image]`.trim()
      : resolved.text || '[empty message]';

    await recordInboundMessage({
      conversationId: conversation.id,
      content: recordedContent,
      igMessageId: inbound.igMessageId,
    });

    // A human (or a closed/waiting state) owns the conversation: persist the
    // inbound message for the dashboard and stop. The bot does not reply.
    if (conversation.status !== 'bot') {
      log.info({ status: conversation.status }, 'conversation not bot-handled; skipping auto-reply');
      await markProcessed(eventKey);
      return;
    }

    const disclosurePrefix =
      isNew && settings.greeting_enabled ? `${settings.disclosure_message}\n\n` : '';

    // No-AI mode: when no model is configured, never call the AI. Send the canned
    // auto-reply and hand the conversation to a human so it surfaces in the inbox.
    if (!aiEnabled) {
      await transitionStatus({
        conversationId: conversation.id,
        to: 'waiting_human',
        reason: 'ai_disabled',
      });
      log.info('AI disabled; sending auto-reply and routing to a human');
      await sendAndRecord({
        conversationId: conversation.id,
        recipientId: inbound.senderId,
        text: `${disclosurePrefix}${env.AUTO_REPLY_MESSAGE}`,
        metadata: { kind: 'auto_reply' },
      });
      await markProcessed(eventKey);
      return;
    }

    // AI path. Any failure here (embedding/generation/keys) routes to a human
    // with the auto-reply rather than leaving the customer with no response.
    try {
      const retrieval = await retrieve(resolved.text || 'image');
      const history = await getRecentHistory(conversation.id, env.RAG_MAX_HISTORY);
      const generation = await generateAnswer({
        settings,
        chunks: retrieval.chunks,
        history,
        isFirstReply: isNew,
        imageUrls: resolved.imageUrls,
      });

      const decision = decideEscalation({
        settings,
        topSimilarity: retrieval.topSimilarity,
        canAnswer: generation.canAnswer,
        userText: resolved.text,
      });

      if (decision.escalate) {
        await transitionStatus({
          conversationId: conversation.id,
          to: 'waiting_human',
          reason: decision.reason ?? 'escalation',
        });
        log.info({ reason: decision.reason, topSimilarity: retrieval.topSimilarity }, 'escalating to human');
        await sendAndRecord({
          conversationId: conversation.id,
          recipientId: inbound.senderId,
          text: `${disclosurePrefix}${BRIDGING_MESSAGE}`,
          metadata: { kind: 'bridging', reason: decision.reason },
        });
        await markProcessed(eventKey);
        return;
      }

      await sendAndRecord({
        conversationId: conversation.id,
        recipientId: inbound.senderId,
        text: `${disclosurePrefix}${generation.answer}`,
        metadata: { kind: 'answer', topSimilarity: retrieval.topSimilarity },
      });
      await markProcessed(eventKey);
    } catch (aiErr) {
      log.error({ err: aiErr }, 'AI pipeline failed; routing to a human with auto-reply');
      await transitionStatus({
        conversationId: conversation.id,
        to: 'waiting_human',
        reason: 'ai_error',
      });
      await sendAndRecord({
        conversationId: conversation.id,
        recipientId: inbound.senderId,
        text: `${disclosurePrefix}${env.AUTO_REPLY_MESSAGE}`,
        metadata: { kind: 'ai_error_fallback' },
      });
      await markProcessed(eventKey);
    }
  } catch (err) {
    log.error({ err }, 'failed to process webhook event');
    await markError(eventKey, errorMessage(err)).catch((e) =>
      log.error({ err: e }, 'failed to record event error'),
    );
  }
}

// Send a bot message and persist its outcome. A send failure is recorded on the
// message row (status=failed) and surfaced on the dashboard — it does not throw,
// so escalation/answer flows complete regardless of Graph API health.
async function sendAndRecord(args: {
  conversationId: string;
  recipientId: string;
  text: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    const result = await sendMessage(args.recipientId, args.text);
    await recordOutboundMessage({
      conversationId: args.conversationId,
      sender: 'bot',
      content: args.text,
      status: 'sent',
      igMessageId: result.messageId || undefined,
      metadata: args.metadata,
    });
  } catch (err) {
    logger.error({ err, conversationId: args.conversationId }, 'failed to send bot message');
    await recordOutboundMessage({
      conversationId: args.conversationId,
      sender: 'bot',
      content: args.text,
      status: 'failed',
      error: errorMessage(err),
      metadata: args.metadata,
    });
  }
}
