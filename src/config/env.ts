import { z } from 'zod';

// Validate all configuration once, at boot. A missing or malformed value should
// crash the process immediately with an actionable message rather than surface
// as a confusing runtime error deep in a request.

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(10000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  // Public anon key. Served to the Flutter app via GET /config so the app does
  // not need it baked in at build time. Safe to expose (RLS-protected).
  SUPABASE_ANON_KEY: z.string().optional(),

  // Comma-separated allowed browser origins for CORS. Unset = allow any origin
  // (acceptable here: agent routes are JWT-protected, the webhook is signed).
  CORS_ORIGINS: z.string().optional(),

  // Verifies the webhook signature (X-Hub-Signature-256). Optional because, with
  // Instagram Login, Meta may sign webhooks with IG_APP_SECRET instead — the
  // verifier accepts either. At least one of the two must be set (refine below).
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().min(1),

  // Instagram Business Login (OAuth). The business connects by logging in; the
  // backend captures, stores, and refreshes the token automatically. All
  // optional so the server still boots before it is connected.
  IG_APP_ID: z.string().optional(),
  IG_APP_SECRET: z.string().optional(),
  IG_REDIRECT_URI: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),
  // Gates who may start the connect flow (?secret=...). Strongly recommended.
  IG_SETUP_SECRET: z.string().optional(),
  // Optional manual fallback token (used if no token has been stored via OAuth).
  IG_ACCESS_TOKEN: z.string().optional(),

  GRAPH_BASE: z.string().url().default('https://graph.instagram.com'),
  GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'expected a version like v23.0').default('v23.0'),

  LLM_PROVIDER: z.enum(['anthropic']).default('anthropic'),
  LLM_MODEL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),

  EMBEDDING_PROVIDER: z.enum(['openai']).default('openai'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  OPENAI_API_KEY: z.string().min(1),

  RAG_TOP_K: z.coerce.number().int().positive().max(20).default(5),
  RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.2),
  RAG_MAX_HISTORY: z.coerce.number().int().positive().max(40).default(8),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  LLM_CONCURRENCY: z.coerce.number().int().positive().max(16).default(3),
  HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
}).refine((env) => Boolean(env.META_APP_SECRET || env.IG_APP_SECRET), {
  message: 'Set META_APP_SECRET or IG_APP_SECRET so webhook signatures can be verified',
  path: ['META_APP_SECRET'],
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Intentionally not using the logger here: config is what the logger depends on.
    process.stderr.write(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
