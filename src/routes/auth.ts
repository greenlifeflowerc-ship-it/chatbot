import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { buildAuthorizeUrl, exchangeCodeForToken, isOAuthConfigured } from '../services/instagram/oauth';
import { consumeState, rememberState } from '../services/instagram/oauthState';
import { getStoredCredentials, saveCredentials } from '../services/instagram/tokenStore';

// When IG_SETUP_SECRET is set, the connect flow requires ?secret=... so random
// visitors cannot initiate an authorization.
function setupSecretOk(provided: string | undefined): boolean {
  if (!env.IG_SETUP_SECRET) return true;
  return provided === env.IG_SETUP_SECRET;
}

function page(title: string, message: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#16181D">` +
    `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1>` +
    `<p style="color:#6B6F76;line-height:1.5">${message}</p></body>`
  );
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Start: redirect the business owner to Instagram to authorize.
  app.get('/auth/instagram', async (request, reply) => {
    if (!isOAuthConfigured()) {
      return reply.code(500).send({
        error: 'oauth_not_configured',
        message: 'Set IG_APP_ID, IG_APP_SECRET, and IG_REDIRECT_URI.',
      });
    }
    const query = request.query as Record<string, string | undefined>;
    if (!setupSecretOk(query.secret)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Missing or invalid setup secret.' });
    }
    const state = crypto.randomUUID();
    rememberState(state);
    return reply.redirect(buildAuthorizeUrl(state));
  });

  // Finish: exchange the code for a token and store it.
  app.get('/auth/instagram/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;

    if (query.error) {
      request.log.warn({ error: query.error, desc: query.error_description }, 'instagram authorization denied');
      return reply
        .code(400)
        .type('text/html')
        .send(page('Connection cancelled', 'Instagram authorization was denied. You can close this tab and try again.'));
    }

    if (!query.code || !query.state || !consumeState(query.state)) {
      return reply
        .code(400)
        .type('text/html')
        .send(page('Invalid request', 'This sign-in link is invalid or has expired. Start again from /auth/instagram.'));
    }

    try {
      const token = await exchangeCodeForToken(query.code);
      const expiresAt = token.expiresInSeconds
        ? new Date(Date.now() + token.expiresInSeconds * 1000).toISOString()
        : null;
      await saveCredentials({
        igUserId: token.igUserId,
        accessToken: token.accessToken,
        tokenType: token.tokenType,
        expiresAt,
      });
      request.log.info({ igUserId: token.igUserId, tokenType: token.tokenType }, 'instagram connected');
      return reply
        .type('text/html')
        .send(page('Instagram connected', 'Your Instagram account is connected. You can close this tab.'));
    } catch (err) {
      request.log.error({ err }, 'instagram oauth callback failed');
      return reply
        .code(502)
        .type('text/html')
        .send(page('Connection failed', 'Could not complete the Instagram connection. Check the server logs and try again.'));
    }
  });

  // Connection status (no token is ever returned).
  app.get('/auth/instagram/status', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (!setupSecretOk(query.secret)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const creds = await getStoredCredentials();
    return reply.send({
      connected: Boolean(creds),
      igUserId: creds?.igUserId ?? null,
      tokenType: creds?.tokenType ?? null,
      expiresAt: creds?.expiresAt ?? null,
    });
  });
}
