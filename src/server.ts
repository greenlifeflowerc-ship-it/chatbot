import { buildServer } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { isOAuthConfigured, refreshLongLivedToken } from './services/instagram/oauth';
import { getStoredCredentials, saveCredentials } from './services/instagram/tokenStore';
import { eventQueue } from './workers/runtime';

const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // refresh when <7 days remain
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // check twice a day

// Keep the stored long-lived Instagram token fresh without manual intervention.
async function maybeRefreshToken(): Promise<void> {
  try {
    const creds = await getStoredCredentials();
    if (!creds?.expiresAt) return;
    const msLeft = Date.parse(creds.expiresAt) - Date.now();
    if (Number.isNaN(msLeft) || msLeft > REFRESH_WINDOW_MS) return;

    const refreshed = await refreshLongLivedToken(creds.accessToken);
    const expiresAt = refreshed.expiresInSeconds
      ? new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString()
      : null;
    await saveCredentials({
      igUserId: creds.igUserId,
      accessToken: refreshed.accessToken,
      tokenType: refreshed.tokenType,
      expiresAt,
    });
    logger.info({ expiresAt }, 'auto-refreshed Instagram token');
  } catch (err) {
    logger.warn({ err }, 'Instagram token refresh check failed');
  }
}

async function start() {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await eventQueue.onIdle();
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server listening');
  } catch (err) {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  }

  if (isOAuthConfigured() && !env.IG_SETUP_SECRET) {
    logger.warn('IG_SETUP_SECRET is not set — the /auth/instagram connect route is unprotected');
  }

  void maybeRefreshToken();
  const refreshTimer = setInterval(() => void maybeRefreshToken(), REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

void start();
