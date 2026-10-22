import { afterAll, describe, expect, it } from 'vitest';
import { closeQueueing, getQueue, startWorker } from '../src/infra/queue';
import { closeRedis, createRedis, getRedis } from '../src/infra/redis';

// Chờ một sự kiện nhưng không bao giờ treo bộ test nếu worker bị kẹt.
const within = <T>(promise: Promise<T>, ms = 8000): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);

afterAll(async () => {
  await closeQueueing();
  await closeRedis();
});

describe('queue infrastructure', () => {
  it('processes a job added through the factory with a worker from the factory', async () => {
    const received = new Promise<number>((resolve) => {
      startWorker<{ n: number }>('test-basic', async (job) => {
        resolve(job.data.n);
        return 'done';
      });
    });
    await getQueue<{ n: number }>('test-basic').add('count', { n: 7 });
    expect(await within(received)).toBe(7);
  });

  it('retries a failing job with backoff until it succeeds', async () => {
    let attempts = 0;
    const succeeded = new Promise<number>((resolve) => {
      startWorker('test-retry', async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('boom');
        resolve(attempts);
      });
    });
    await getQueue('test-retry').add('flaky', {}, { attempts: 3, backoff: { type: 'fixed', delay: 20 } });
    expect(await within(succeeded)).toBe(3);
  });

  it('keeps every key under the configured prefix', async () => {
    const keys = await (await getRedis()).keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('cmbe-test:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('bull:'))).toBe(false);
  });

  it('uses fail-fast settings for producers and BullMQ-required settings for workers', () => {
    const producer = createRedis('queue');
    const worker = createRedis('worker');
    expect(producer.options.enableOfflineQueue).toBe(false);
    expect(worker.options.maxRetriesPerRequest).toBeNull();
  });

  it('shuts down workers, queues and connections without hanging', async () => {
    await within(closeQueueing(), 5000);
    await within(closeRedis(), 5000);
  });
});
