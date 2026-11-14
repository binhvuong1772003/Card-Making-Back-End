import { Router, type RequestHandler } from 'express';
import { rateLimiter, userRateLimiter } from '../../http/rate-limit';
import { prisma } from '../../infra/prisma';
import { AppError } from '../../shared/errors';
import { requireAuth } from '../auth/auth.middleware';
import { createCatalogSignHandler, createSignHandler } from './assets.controller';
import type { CloudinaryConfig } from './assets.service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Giới hạn theo IP (chặn dội ở cửa), rồi theo người dùng mỗi giờ và mỗi ngày (chặn một tài khoản xin ký liên tục).
export function createAssetsRouter(options: { rateLimit: number; userHourlyLimit: number; userDailyLimit: number; cloudinary: CloudinaryConfig | null }): Router {
  const router = Router();
  const requireCatalogAdmin: RequestHandler = async (_req, res, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: res.locals.auth!.userId }, select: { role: true } });
      if (user?.role !== 'ADMIN') throw new AppError('FORBIDDEN', 'You do not have permission to do that');
      next();
    } catch (error) { next(error); }
  };
  router.post(
    '/sign',
    rateLimiter(options.rateLimit),
    requireAuth,
    userRateLimiter({ windowMs: HOUR, limit: options.userHourlyLimit }),
    userRateLimiter({ windowMs: DAY, limit: options.userDailyLimit }),
    createSignHandler(options.cloudinary),
  );
  router.post('/catalog/sign', rateLimiter(options.rateLimit), requireAuth, requireCatalogAdmin, createCatalogSignHandler(options.cloudinary));
  return router;
}
