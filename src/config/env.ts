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

  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  IG_ACCESS_TOKEN: z.string().min(1),
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
