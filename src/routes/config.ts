import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';

// Public runtime config for the Flutter dashboard. The app fetches this at
// startup instead of having Supabase values compiled in. Only public values are
// returned — the anon key is RLS-protected and safe to expose; the service-role
// key is never included.
export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async (_request, reply) => {
    if (!env.SUPABASE_ANON_KEY) {
      return reply.code(503).send({
        error: 'config_unavailable',
        message: 'SUPABASE_ANON_KEY is not set on the server.',
      });
    }
    return reply.send({
      supabaseUrl: env.SUPABASE_URL,
      supabaseAnonKey: env.SUPABASE_ANON_KEY,
    });
  });
}
