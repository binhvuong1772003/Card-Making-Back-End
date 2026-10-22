import { Router } from 'express';
import { prisma } from '../infra/prisma';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'CMBE' });
});

router.get('/ready', async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

export default router;
