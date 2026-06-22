import { buildServer } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { eventQueue } from './workers/runtime';

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
}

void start();
