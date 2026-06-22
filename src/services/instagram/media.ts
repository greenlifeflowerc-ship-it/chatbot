import OpenAI, { toFile } from 'openai';
import { aiEnabled, env } from '../../config/env';
import { logger } from '../../lib/logger';
import { withRetry } from '../../lib/retry';
import type { InboundMessage } from '../../types';

// Voice + image understanding via Groq (Whisper for audio, a vision model for
// images). All best-effort: any failure degrades to a short placeholder so the
// text reply flow never breaks.

function groqClient(): OpenAI {
  return new OpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    fetch: globalThis.fetch,
  });
}

async function fetchAttachment(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`attachment download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}

async function transcribeAudio(url: string): Promise<string> {
  const { buffer } = await fetchAttachment(url);
  const file = await toFile(buffer, 'audio.m4a');
  const result = await withRetry(
    () => groqClient().audio.transcriptions.create({ file, model: env.GROQ_WHISPER_MODEL }),
    { retries: 2, label: 'groq.transcribe' },
  );
  return (result.text ?? '').trim();
}

async function describeImage(url: string): Promise<string> {
  const resp = await withRetry(
    () =>
      groqClient().chat.completions.create({
        model: env.GROQ_VISION_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe what the customer is showing in this image, including any product, item, or text visible. Be concise.',
              },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
      }),
    { retries: 2, label: 'groq.vision' },
  );
  return (resp.choices[0]?.message?.content ?? '').trim();
}

// Resolve an inbound message (text and/or attachments) into the text the bot
// should reason over. Transcribes voice, describes images; falls back to a short
// placeholder when AI is off or a media call fails.
export async function resolveInboundContent(inbound: InboundMessage): Promise<string> {
  const parts: string[] = [];
  if (inbound.text) parts.push(inbound.text);

  for (const att of inbound.attachments) {
    const type = att.type.toLowerCase();
    if (!aiEnabled) {
      parts.push(`[customer sent ${type === 'audio' ? 'a voice message' : `a ${type}`}]`);
      continue;
    }
    try {
      if (type === 'audio') {
        const text = await transcribeAudio(att.url);
        parts.push(text ? `(voice message) ${text}` : '[voice message: could not transcribe]');
      } else if (type === 'image') {
        const desc = await describeImage(att.url);
        parts.push(desc ? `(customer sent an image) ${desc}` : '[customer sent an image]');
      } else {
        parts.push(`[customer sent a ${type}]`);
      }
    } catch (err) {
      logger.warn({ err, type }, 'failed to process attachment');
      parts.push(type === 'audio' ? '[voice message: could not transcribe]' : `[customer sent a ${type}]`);
    }
  }

  return parts.join('\n').trim() || '[empty message]';
}
