import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { supabase } from '../lib/supabase';
import { verifySignature } from '../services/instagram/signature';
import { extractInboundMessages, parseWebhookPayload } from '../services/instagram/parse';
import { processEvent } from '../workers/processEvent';
import { eventQueue } from '../workers/runtime';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // GET — Meta verification handshake.
  app.get('/webhook', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];

    if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN && challenge) {
      return reply.code(200).type('text/plain').send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  // POST — receive events. Order is deliberate: verify signature, acknowledge
  // fast, then dedupe + enqueue. No RAG or Graph API work happens on this path.
  app.post('/webhook', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'];
    if (!request.rawBody || !verifySignature(request.rawBody, typeof signature === 'string' ? signature : undefined)) {
      return reply.code(403).send({ error: 'invalid_signature' });
    }

    let events;
    try {
      const payload = parseWebhookPayload(request.body);
      events = extractInboundMessages(payload);
    } catch (err) {
      // Signature was valid but the shape is unexpected. Acknowledge so Meta
      // stops retrying; there is nothing actionable to process.
      request.log.warn({ err }, 'unparseable webhook payload; acknowledging');
      return reply.code(200).send({ ok: true });
    }

    for (const event of events) {
      // ON CONFLICT DO NOTHING via ignoreDuplicates: a non-empty result means
      // this id is new and should be processed; an empty result is a redelivery.
      const { data, error } = await supabase
        .from('webhook_events')
        .upsert(
          { event_key: event.eventKey, payload: event.inbound },
          { onConflict: 'event_key', ignoreDuplicates: true },
        )
        .select('id');

      if (error) {
        request.log.error({ err: error, eventKey: event.eventKey }, 'failed to record webhook event');
        continue;
      }
      if (!data || data.length === 0) {
        request.log.debug({ eventKey: event.eventKey }, 'duplicate webhook event ignored');
        continue;
      }

      eventQueue.enqueue(() => processEvent(event));
    }

    return reply.code(200).send({ ok: true });
  });
}
