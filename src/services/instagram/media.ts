import OpenAI, { toFile } from 'openai';
import { aiEnabled, env } from '../../config/env';
import { logger } from '../../lib/logger';
import { nativeFetch } from '../../lib/nativeFetch';
import { withRetry } from '../../lib/retry';
import type { InboundMessage } from '../../types';

// Voice + image understanding. Audio is transcribed to text (Groq Whisper).
// Images are passed through as URLs so the vision model sees them together with
// the customer's question — not turned into a lossy text description.

export interface ResolvedContent {
  text: string; // customer text + transcribed voice
  imageUrls: string[]; // image attachments, handed to the vision model
}

function groqClient(): OpenAI {
  return new OpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    fetch: nativeFetch,
  });
}

function audioExt(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('aac')) return 'aac';
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  if (ct.includes('ogg')) return 'ogg';
  if (ct.includes('wav')) return 'wav';
  if (ct.includes('webm')) return 'webm';
  return 'm4a';
}

async function transcribeAudio(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio download failed: ${res.status}`);
  const contentType = res.headers.get('content-type') ?? 'audio/mp4';
  const buffer = Buffer.from(await res.arrayBuffer());
  const file = await toFile(buffer, `audio.${audioExt(contentType)}`, { type: contentType });

  const result = await withRetry(
    () => groqClient().audio.transcriptions.create({ file, model: env.GROQ_WHISPER_MODEL }),
    { retries: 2, label: 'groq.transcribe' },
  );
  return (result.text ?? '').trim();
}

// Split an inbound message into the text to reason over (its text plus any
// transcribed voice) and the image URLs to show the vision model. All media is
// best-effort: failures degrade to a short note rather than breaking the reply.
export async function resolveInboundContent(inbound: InboundMessage): Promise<ResolvedContent> {
  const parts: string[] = [];
  if (inbound.text) parts.push(inbound.text);
  const imageUrls: string[] = [];

  for (const att of inbound.attachments) {
    const type = att.type.toLowerCase();
    if (type === 'image') {
      imageUrls.push(att.url);
      continue;
    }
    if (type === 'audio') {
      if (!aiEnabled) {
        parts.push('[voice message]');
        continue;
      }
      try {
        const text = await transcribeAudio(att.url);
        parts.push(text ? `(voice message) ${text}` : '[voice message: could not transcribe]');
      } catch (err) {
        logger.warn({ err }, 'failed to transcribe voice message');
        parts.push('[voice message: could not transcribe]');
      }
      continue;
    }
    parts.push(`[customer sent a ${type}]`);
  }

  return { text: parts.join('\n').trim(), imageUrls };
}
