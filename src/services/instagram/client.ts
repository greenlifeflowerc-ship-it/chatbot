import { env } from '../../config/env';
import { UpstreamError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { withRetry } from '../../lib/retry';
import { getAccessToken } from './tokenStore';

// Instagram Graph API client (Instagram Login flavour — graph.instagram.com).
// Base URL and version come from env so the API version is never hardcoded.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type MessageTag = 'human_agent';

export interface SendMessageOptions {
  // Attach a message tag to send outside the standard 24-hour window. Only valid
  // for human agent replies; bot replies outside the window must not be sent.
  tag?: MessageTag;
}

export interface SendMessageResult {
  recipientId: string;
  messageId: string;
}

// True when the customer messaged within the last 24h, i.e. standard messaging
// is allowed. A null timestamp (no customer message on record) is treated as
// outside the window.
export function isWithinStandardWindow(lastCustomerAt: string | null, now: number = Date.now()): boolean {
  if (!lastCustomerAt) return false;
  const last = Date.parse(lastCustomerAt);
  if (Number.isNaN(last)) return false;
  return now - last < WINDOW_MS;
}

async function graphFetch(path: string, init: RequestInit): Promise<unknown> {
  const url = `${env.GRAPH_BASE}/${env.GRAPH_VERSION}/${path}`;
  const token = await getAccessToken();
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    // Network-level failure — retryable.
    throw new UpstreamError('Graph API request failed', { retryable: true, cause });
  }

  const bodyText = await res.text();
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }

  if (!res.ok) {
    // 5xx and 429 are worth retrying; 4xx (bad token, permissions, outside
    // window) are not — retrying would just repeat the same rejection.
    const retryable = res.status >= 500 || res.status === 429;
    throw new UpstreamError(`Graph API responded ${res.status}`, {
      statusCode: res.status,
      retryable,
      cause: body,
    });
  }

  return body;
}

// Send a text message to a customer. Wrapped in backoff; the caller is
// responsible for the 24h-window decision (see isWithinStandardWindow).
export async function sendMessage(
  recipientId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const payload: Record<string, unknown> = {
    recipient: { id: recipientId },
    message: { text },
  };
  if (options.tag) {
    payload.messaging_type = 'MESSAGE_TAG';
    payload.tag = options.tag;
  }

  const body = (await withRetry(
    () =>
      graphFetch('me/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    { retries: env.HTTP_MAX_RETRIES, label: 'ig.sendMessage' },
  )) as { recipient_id?: string; message_id?: string };

  return {
    recipientId: body.recipient_id ?? recipientId,
    messageId: body.message_id ?? '',
  };
}

// Subscribe the connected Instagram account to message webhooks. This is a
// required step with Instagram Login: without it, Instagram does NOT deliver DM
// webhooks for the account even when the app-level webhook is configured.
export async function subscribeToMessages(): Promise<boolean> {
  const body = (await withRetry(
    () => graphFetch('me/subscribed_apps?subscribed_fields=messages', { method: 'POST' }),
    { retries: 2, label: 'ig.subscribeToMessages' },
  )) as { success?: boolean };
  return body.success === true;
}

// Whether the connected account is currently subscribed to message webhooks.
// Best-effort — returns false if the check fails.
export async function isSubscribedToMessages(): Promise<boolean> {
  try {
    const body = (await graphFetch('me/subscribed_apps', { method: 'GET' })) as {
      data?: Array<{ subscribed_fields?: Array<string | { name?: string }> }>;
    };
    return (body.data ?? []).some((app) =>
      (app.subscribed_fields ?? []).some((f) => (typeof f === 'string' ? f : f.name) === 'messages'),
    );
  } catch (err) {
    logger.warn({ err }, 'could not read Instagram webhook subscription');
    return false;
  }
}

export interface IgProfile {
  username: string | null;
  name: string | null;
  profilePic: string | null;
}

// Best-effort profile lookup for a customer IGSID. Returns null on failure so a
// profile-fetch problem never blocks message handling.
export async function getUserProfile(igUserId: string): Promise<IgProfile | null> {
  try {
    const body = (await withRetry(
      () => graphFetch(`${igUserId}?fields=name,username,profile_pic`, { method: 'GET' }),
      { retries: 2, label: 'ig.getUserProfile' },
    )) as { username?: string; name?: string; profile_pic?: string };

    return {
      username: body.username ?? null,
      name: body.name ?? null,
      profilePic: body.profile_pic ?? null,
    };
  } catch (err) {
    logger.warn({ err, igUserId }, 'failed to fetch IG profile; continuing without it');
    return null;
  }
}
