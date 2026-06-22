import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../src/services/instagram/signature';

// Must match test/setup.ts META_APP_SECRET.
const secret = 'test-app-secret';
const sign = (body: Buffer) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifySignature', () => {
  const body = Buffer.from(JSON.stringify({ object: 'instagram', entry: [] }));

  it('accepts a valid signature', () => {
    expect(verifySignature(body, sign(body))).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature(Buffer.from('different bytes'), sign(body))).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifySignature(body, undefined)).toBe(false);
    expect(verifySignature(body, 'sha1=deadbeef')).toBe(false);
    expect(verifySignature(body, 'sha256=tooshort')).toBe(false);
  });
});
