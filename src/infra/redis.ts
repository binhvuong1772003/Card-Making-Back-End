import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

export type RedisRole = 'shared' | 'queue' | 'worker';

const options: Record<RedisRole, RedisOptions> = {
  // /ready và lệnh lẻ: thất bại nhanh thay vì treo khi Redis chết.
  shared: { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000 },
  // Producer (queue.add): cũng thất bại nhanh, để request không bị treo.
  queue: { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000 },
  // BullMQ bắt buộc maxRetriesPerRequest = null cho worker.
  worker: { maxRetriesPerRequest: null },
};

// BullMQ không đóng các kết nối ioredis do ta truyền vào, nên tự theo dõi để đóng lúc tắt server.
const connections = new Set<Redis>();

export function createRedis(role: RedisRole): Redis {
  const redis = new Redis(env.REDIS_URL, options[role]);
  redis.on('error', (err) => logger.warn({ err, role }, 'redis error'));
  connections.add(redis);
  return redis;
}

let shared: Promise<Redis> | undefined;

// Kết nối dùng chung cho kiểm tra sức khỏe; trả về khi đã sẵn sàng (hoặc lỗi sau 5 giây).
export function getRedis(): Promise<Redis> {
  shared ??= new Promise<Redis>((resolve, reject) => {
    const redis = createRedis('shared');
    const timer = setTimeout(() => reject(new Error('redis connection timed out')), 5000);
    redis.once('ready', () => {
      clearTimeout(timer);
      resolve(redis);
    });
  }).catch((err) => {
    shared = undefined;
    throw err;
  });
  return shared;
}

export async function closeRedis(): Promise<void> {
  const all = [...connections];
  connections.clear();
  shared = undefined;
  await Promise.all(
    all.map(async (redis) => {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    }),
  );
}
