import { env } from '../../config/env';
import { ConfigError, UpstreamError } from '../../lib/errors';

// Instagram Business Login (OAuth). The business owner authorizes once; we
// exchange the returned code for a long-lived token (~60 days) and store it.

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const SCOPES = 'instagram_business_basic,instagram_business_manage_messages';

export interface OAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export function isOAuthConfigured(): boolean {
  return Boolean(env.IG_APP_ID && env.IG_APP_SECRET && env.IG_REDIRECT_URI);
}

function requireConfig(): OAuthConfig {
  if (!env.IG_APP_ID || !env.IG_APP_SECRET || !env.IG_REDIRECT_URI) {
    throw new ConfigError('Instagram OAuth is not configured (IG_APP_ID, IG_APP_SECRET, IG_REDIRECT_URI).');
  }
  return { appId: env.IG_APP_ID, appSecret: env.IG_APP_SECRET, redirectUri: env.IG_REDIRECT_URI };
}

export function buildAuthorizeUrl(state: string): string {
  const { appId, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface ResolvedToken {
  accessToken: string;
  tokenType: string | null;
  expiresInSeconds: number | null;
  igUserId: string | null;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { raw: text };
  }
}

// Exchange the authorization code for a long-lived token. Falls back to the
// short-lived token if the long-lived exchange fails, so a connection still
// succeeds (auto-refresh will upgrade it later).
export async function exchangeCodeForToken(code: string): Promise<ResolvedToken> {
  const { appId, appSecret, redirectUri } = requireConfig();

  const form = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });

  const shortRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const shortBody = await readJson(shortRes);
  const shortToken = shortBody.access_token;
  if (!shortRes.ok || typeof shortToken !== 'string') {
    throw new UpstreamError('Instagram code exchange failed', {
      statusCode: shortRes.status,
      retryable: false,
      cause: shortBody,
    });
  }
  const igUserId = shortBody.user_id != null ? String(shortBody.user_id) : null;

  const longUrl =
    `${env.GRAPH_BASE}/access_token?grant_type=ig_exchange_token` +
    `&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortToken)}`;
  const longRes = await fetch(longUrl);
  const longBody = await readJson(longRes);
  const longToken = longBody.access_token;

  if (!longRes.ok || typeof longToken !== 'string') {
    return { accessToken: shortToken, tokenType: 'short_lived', expiresInSeconds: null, igUserId };
  }
  return {
    accessToken: longToken,
    tokenType: typeof longBody.token_type === 'string' ? longBody.token_type : 'long_lived',
    expiresInSeconds: typeof longBody.expires_in === 'number' ? longBody.expires_in : null,
    igUserId,
  };
}

export async function refreshLongLivedToken(token: string): Promise<ResolvedToken> {
  const url =
    `${env.GRAPH_BASE}/refresh_access_token?grant_type=ig_refresh_token` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const body = await readJson(res);
  const refreshed = body.access_token;
  if (!res.ok || typeof refreshed !== 'string') {
    throw new UpstreamError('Instagram token refresh failed', {
      statusCode: res.status,
      retryable: true,
      cause: body,
    });
  }
  return {
    accessToken: refreshed,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'long_lived',
    expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : null,
    igUserId: null,
  };
}
