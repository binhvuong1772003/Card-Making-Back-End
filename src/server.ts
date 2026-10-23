import http from 'node:http';
import { createApp, defaultGraphql } from './app';
import { env } from './config/env';
import { logger } from './infra/logger';
import { prisma } from './infra/prisma';
import { closeQueueing } from './infra/queue';
import { closeRedis, getRedis } from './infra/redis';
import { warmUp as warmUpAuth } from './modules/auth/auth.service';
import { startWorkers } from './worker';

async function main(): Promise<void> {
  await prisma.$connect();
  await getRedis();
  await warmUpAuth();
  if (env.RUN_WORKERS) startWorkers();

  const graphql = defaultGraphql();
  await graphql.start(); // lỗi cấu hình GraphQL làm server dừng ngay lúc khởi động

  const server = http.createServer(createApp({ graphql }));
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'CMBE listening'));

  // Thứ tự tắt: ngừng nhận kết nối, worker và queue, Redis, rồi Prisma.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await graphql.stop();
      await closeQueueing();
      await closeRedis();
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'startup failed');
  process.exit(1);
});
