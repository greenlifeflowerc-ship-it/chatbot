import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app';

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const sign = (body: string) =>
  `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;

describe('GET /webhook verification handshake', () => {
  it('echoes the challenge on a matching verify token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhook',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': 'echo-me' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('echo-me');
  });

  it('returns 403 on a wrong verify token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhook',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'echo-me' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /webhook signature gate', () => {
  const body = JSON.stringify({ object: 'instagram', entry: [] });
  const headers = { 'content-type': 'application/json' } as const;

  it('rejects a missing signature', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhook', headers, payload: body });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { ...headers, 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a valid signature (no events => no DB work)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { ...headers, 'x-hub-signature-256': sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('agent routes require authentication', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agent/conversations/00000000-0000-0000-0000-000000000000/close',
    });
    expect(res.statusCode).toBe(401);
  });
});
