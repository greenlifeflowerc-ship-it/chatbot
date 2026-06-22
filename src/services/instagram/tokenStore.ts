import { env } from '../../config/env';
import { UpstreamError } from '../../lib/errors';
import { supabase } from '../../lib/supabase';

// The Instagram access token obtained via OAuth lives in the database (single
// row), so it survives restarts and is shared across instances. This module is
// the only reader/writer; the Graph client asks it for the current token.

export interface StoredCredentials {
  igUserId: string | null;
  accessToken: string;
  tokenType: string | null;
  expiresAt: string | null;
}

interface CredentialsRow {
  ig_user_id: string | null;
  access_token: string;
  token_type: string | null;
  expires_at: string | null;
}

// Short in-memory cache so a burst of sends does not hit the DB for every call.
let cache: { token: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

// The token the Graph client should use right now. Prefers the stored OAuth
// token, falls back to a manually set IG_ACCESS_TOKEN, and throws a clear error
// if Instagram has not been connected yet.
export async function getAccessToken(): Promise<string> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.token;

  const { data, error } = await supabase
    .from('instagram_credentials')
    .select('access_token')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    if (env.IG_ACCESS_TOKEN) return env.IG_ACCESS_TOKEN;
    throw new UpstreamError('failed to load Instagram credentials', { retryable: true, cause: error });
  }

  const token = (data as { access_token: string } | null)?.access_token ?? env.IG_ACCESS_TOKEN ?? '';
  if (!token) {
    throw new UpstreamError('Instagram is not connected — visit /auth/instagram to connect.', {
      retryable: false,
    });
  }

  cache = { token, fetchedAt: Date.now() };
  return token;
}

export async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  const { error } = await supabase.from('instagram_credentials').upsert({
    id: 1,
    ig_user_id: credentials.igUserId,
    access_token: credentials.accessToken,
    token_type: credentials.tokenType,
    expires_at: credentials.expiresAt,
    updated_at: nowIso(),
  });
  if (error) {
    throw new UpstreamError('failed to store Instagram credentials', { retryable: true, cause: error });
  }
  cache = { token: credentials.accessToken, fetchedAt: Date.now() };
}

export async function getStoredCredentials(): Promise<StoredCredentials | null> {
  const { data, error } = await supabase
    .from('instagram_credentials')
    .select('ig_user_id, access_token, token_type, expires_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    throw new UpstreamError('failed to load Instagram credentials', { retryable: true, cause: error });
  }
  if (!data) return null;
  const row = data as CredentialsRow;
  return {
    igUserId: row.ig_user_id,
    accessToken: row.access_token,
    tokenType: row.token_type,
    expiresAt: row.expires_at,
  };
}

export function clearTokenCache(): void {
  cache = null;
}
