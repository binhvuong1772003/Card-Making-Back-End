import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import { env } from '../config/env';
import { logger } from './logger';
import { createRedis } from './redis';

// Đây là hàng đợi JOB NỀN. Không liên quan hàng đợi tuần tự theo thiệp của applyOps (card-queue.ts).
// Mọi Queue và Worker dùng cùng QUEUE_PREFIX; lệch prefix thì job được thêm vào nhưng không ai xử lý.

export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

const queues = new Map<string, Queue>();
const workers = new Set<Worker>();

export function getQueue<T>(name: string): Queue<T> {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: createRedis('queue'), prefix: env.QUEUE_PREFIX, defaultJobOptions });
    queues.set(name, queue);
  }
  return queue as Queue<T>;
}

export function startWorker<T>(name: string, processor: Processor<T>, workerOptions: Partial<WorkerOptions> = {}): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    concurrency: 5,
    ...workerOptions,
    connection: createRedis('worker'),
    prefix: env.QUEUE_PREFIX,
  });
  // Không ghi job.data vào log: payload chỉ chứa id nhưng vẫn là dữ liệu của người dùng.
  worker.on('failed', (job, err) =>
    logger.warn({ queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade, err }, 'job failed'),
  );
  worker.on('error', (err) => logger.error({ queue: name, err }, 'worker error'));
  workers.add(worker);
  return worker;
}

// Thứ tự: worker (để job đang chạy xong), rồi queue. Kết nối Redis đóng riêng bằng closeRedis().
export async function closeQueueing(): Promise<void> {
  const ws = [...workers];
  const qs = [...queues.values()];
  workers.clear();
  queues.clear();
  await Promise.all(ws.map((worker) => worker.close()));
  await Promise.all(qs.map((queue) => queue.close()));
}
