import { env } from '../config/env';
import { AsyncQueue } from '../lib/queue';

// Single process-wide work queue the webhook route enqueues into and the worker
// drains. Kept in its own module so the route and server can share the instance
// without importing the worker (which would create a cycle).
export const eventQueue = new AsyncQueue(env.WORKER_CONCURRENCY);
