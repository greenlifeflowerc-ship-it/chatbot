import { describe, expect, it } from 'vitest';
import { AsyncQueue, createLimiter } from '../src/lib/queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createLimiter', () => {
  it('caps concurrency', async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(10);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('AsyncQueue', () => {
  it('runs every enqueued task and drains', async () => {
    const q = new AsyncQueue(2);
    let done = 0;
    for (let i = 0; i < 5; i += 1) q.enqueue(async () => { await sleep(5); done += 1; });
    await q.onIdle();
    expect(done).toBe(5);
  });

  it('isolates a failing task from its siblings', async () => {
    const q = new AsyncQueue(1);
    let ranAfterFailure = false;
    q.enqueue(async () => { throw new Error('boom'); });
    q.enqueue(async () => { ranAfterFailure = true; });
    await q.onIdle();
    expect(ranAfterFailure).toBe(true);
  });
});
