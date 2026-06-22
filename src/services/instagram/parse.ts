import { z } from 'zod';
import type { WebhookMessageEvent } from '../../types';

// Instagram messaging webhook envelope. We validate defensively and only the
// fields we act on; unknown fields are ignored so Meta can add them without
// breaking us.
const MessagingSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number().optional(),
  message: z
    .object({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
    })
    .optional(),
});

const EntrySchema = z.object({
  id: z.string().optional(),
  time: z.number().optional(),
  messaging: z.array(MessagingSchema).optional(),
});

const WebhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(EntrySchema),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

export function parseWebhookPayload(body: unknown): WebhookPayload {
  return WebhookPayloadSchema.parse(body);
}

// Extract the inbound customer text messages we can act on. Echoes (our own
// outbound), reactions, read receipts, and attachment-only messages are skipped
// — there is nothing for the bot to answer in those.
export function extractInboundMessages(payload: WebhookPayload): WebhookMessageEvent[] {
  const events: WebhookMessageEvent[] = [];

  for (const entry of payload.entry) {
    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      if (!msg || msg.is_echo) continue;
      const text = msg.text?.trim();
      if (!text) continue;

      events.push({
        eventKey: msg.mid,
        inbound: {
          igMessageId: msg.mid,
          senderId: m.sender.id,
          recipientId: m.recipient.id,
          text,
          timestamp: m.timestamp ?? entry.time ?? 0,
        },
      });
    }
  }

  return events;
}
