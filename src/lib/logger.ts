import { pino } from 'pino';
import { env, isProduction } from '../config/env';

// Structured logging. In production we emit JSON (Render captures stdout); in
// development we pretty-print. Secrets and raw message bodies are redacted so
// they never reach the logs.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      'access_token',
      'token',
      '*.access_token',
      '*.api_key',
    ],
    censor: '[redacted]',
  },
  transport: isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});

export type Logger = typeof logger;
