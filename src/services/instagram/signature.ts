import crypto from 'node:crypto';
import { env } from '../../config/env';

// Secrets that may have signed the webhook. With Instagram Login, Meta may sign
// with the Instagram app secret rather than the base Meta app secret, so we
// accept either — whichever is configured.
function candidateSecrets(): string[] {
  return [env.META_APP_SECRET, env.IG_APP_SECRET].filter((s): s is string => Boolean(s));
}

// Verify Meta's X-Hub-Signature-256 header against the raw request body.
// HMAC-SHA256 keyed with an app secret; compared in constant time against each
// candidate secret. The raw bytes (pre-JSON-parse) must be passed in —
// re-serialising the parsed body would not reproduce the exact bytes Meta signed.
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const received = Buffer.from(signatureHeader);

  for (const secret of candidateSecrets()) {
    const expected = Buffer.from(
      `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    );
    if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
      return true;
    }
  }
  return false;
}
