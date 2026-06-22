import { logger } from './logger';

export type Task = () => Promise<void>;

// Bounded-concurrency async limiter. Wrap any async unit of work to cap how many
// run at once (e.g. LLM calls) without serialising everything.
export function createLimiter(concurrency: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  };

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// In-process work queue with a concurrency cap. Tasks are fire-and-forget from
// the caller's perspective (the webhook route enqueues and returns immediately).
// A task that throws is logged and dropped — it must never take down the queue
// or block siblings. Durable retry lives in the worker via the webhook_events
// table, not here.
export class AsyncQueue {
  private readonly pending: Task[] = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  enqueue(task: Task): void {
    this.pending.push(task);
    this.drain();
  }

  get size(): number {
    return this.pending.length + this.active;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active += 1;
      void task()
        .catch((err) => {
          logger.error({ err }, 'queued task failed');
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  // Resolves when the queue has fully drained. Used by tests and graceful shutdown.
  async onIdle(): Promise<void> {
    while (this.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
