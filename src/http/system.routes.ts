import { Router } from 'express';
import { prisma } from '../infra/prisma';
import { getRedis } from '../infra/redis';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'CMBE' });
});

// Mỗi kiểm tra có giới hạn thời gian để /ready trả 503 thay vì treo khi một thành phần chết.
async function check(run: () => Promise<unknown>, ms = 2000): Promise<'ok' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

router.get('/ready', async (_req, res) => {
  const [database, redis] = await Promise.all([
    check(() => prisma.$runCommandRaw({ ping: 1 })),
    check(async () => (await getRedis()).ping()),
  ]);
  const ready = database === 'ok' && redis === 'ok';
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks: { database, redis } });
});

export default router;
