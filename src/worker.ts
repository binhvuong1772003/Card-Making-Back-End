import type { Worker } from 'bullmq';
import { env } from './config/env';
import { logger } from './infra/logger';
import { getMailer } from './infra/mailer';
import { prisma } from './infra/prisma';
import { closeQueueing } from './infra/queue';
import { closeRedis, getRedis } from './infra/redis';
import { startEmailWorker } from './modules/auth/email.jobs';

// Mỗi module thêm bộ xử lý job của mình vào đây (ví dụ auth/session-cleanup.jobs.ts, auth/email.jobs.ts).
// Quy tắc: payload của job chỉ chứa id; bộ xử lý gọi service của module sở hữu; job phải làm lại được an toàn.
const registrations: Array<() => Worker> = [() => startEmailWorker(getMailer())];

export function startWorkers(): Worker[] {
  const started = registrations.map((start) => start());
  logger.info(
    { count: started.length, mailTransport: env.MAIL_TRANSPORT },
    started.length === 0 ? 'no job processors registered' : 'job processors started',
  );
  return started;
}

// Chạy riêng một tiến trình worker: `npm run dev:worker` hoặc `npm run start:worker`.
// Mặc định worker chạy chung tiến trình API (RUN_WORKERS=true trong server.ts).
async function main(): Promise<void> {
  await prisma.$connect();
  await getRedis();
  startWorkers();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    await closeQueueing();
    await closeRedis();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'worker startup failed');
    process.exit(1);
  });
}
