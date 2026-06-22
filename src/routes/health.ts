import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase';

// Liveness + keep-alive. The tiny Supabase read keeps the free-tier database
// from idling and confirms the Data API is reachable. UptimeRobot pings this
// every 5 minutes, which also keeps the Render service warm.
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request, reply) => {
    const { error } = await supabase
      .from('bot_settings')
      .select('id', { head: true, count: 'exact' })
      .eq('id', 1);

    if (error) {
      request.log.error({ err: error }, 'health check: database read failed');
      return reply.code(503).send({ status: 'degraded', db: 'error' });
    }

    return reply.code(200).send({
      status: 'ok',
      db: 'ok',
      uptime: Math.round(process.uptime()),
    });
  });
}
