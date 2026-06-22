import crypto from 'node:crypto';
import { env } from '../../config/env';

// Verify Meta's X-Hub-Signature-256 header against the raw request body.
// HMAC-SHA256 keyed with the app secret; compared in constant time to avoid a
// timing oracle. The raw bytes (pre-JSON-parse) must be passed in — re-serialising
// the parsed body would not reproduce the exact bytes Meta signed.
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', env.META_APP_SECRET)
    .update(rawBody)
    .digest('hex')}`;

  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);
  if (received.length !== computed.length) return false;

  return crypto.timingSafeEqual(received, computed);
}
