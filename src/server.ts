import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './infra/logger';
import { prisma } from './infra/prisma';
import { warmUp as warmUpAuth } from './modules/auth/auth.service';

async function main(): Promise<void> {
  await prisma.$connect();
  await warmUpAuth();
  const server = http.createServer(createApp());
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'CMBE listening'));

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
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
