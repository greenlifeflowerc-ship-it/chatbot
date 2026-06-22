import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { env, isProduction } from './config/env';
import { errorMessage, isAppError } from './lib/errors';
import { logger } from './lib/logger';
import { agentRoutes } from './routes/agent';
import { authRoutes } from './routes/auth';
import { configRoutes } from './routes/config';
import { healthRoutes } from './routes/health';
import { webhookRoutes } from './routes/webhook';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

// Construct the configured Fastify instance without starting it. Kept separate
// from server bootstrap so tests can drive it via inject(). The return type is
// inferred so the pino logger instance type flows through correctly.
export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // Render terminates TLS upstream; trust X-Forwarded-* for real client IPs.
    bodyLimit: 1_048_576, // 1 MiB
    disableRequestLogging: isProduction, // we log meaningful events ourselves
  });

  // Capture the raw body for webhook signature verification while still parsing
  // JSON for handlers. Re-serialising the parsed object would not reproduce the
  // exact bytes Meta signed.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    const buf = body as Buffer;
    if (!buf || buf.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // CORS so the browser-based dashboard can call /config and /agent. Origins are
  // restricted by CORS_ORIGINS when set; otherwise any origin is allowed (agent
  // routes are JWT-protected regardless).
  const corsOrigins = env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  // Defensive rate limit on the public surface. Signature verification is the
  // real gate; this caps abusive volume without dropping Meta's normal traffic.
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute', allowList: [] });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({ issues: error.issues }, 'request validation failed');
      return reply.code(400).send({
        error: 'validation_error',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    if (isAppError(error)) {
      const log = error.statusCode >= 500 ? request.log.error : request.log.warn;
      log.call(request.log, { err: error, code: error.code }, error.message);
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    else request.log.warn({ err: error }, errorMessage(error));
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'request_error' });
  });

  await app.register(healthRoutes);
  await app.register(configRoutes);
  await app.register(authRoutes);
  await app.register(webhookRoutes);
  await app.register(agentRoutes, { prefix: '/agent' });

  return app;
}
