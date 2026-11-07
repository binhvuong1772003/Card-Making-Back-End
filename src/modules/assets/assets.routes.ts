import { Router } from 'express';
import { rateLimiter, userRateLimiter } from '../../http/rate-limit';
import { requireAuth } from '../auth/auth.middleware';
import { createSignHandler } from './assets.controller';
import type { CloudinaryConfig } from './assets.service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Giới hạn theo IP (chặn dội ở cửa), rồi theo người dùng mỗi giờ và mỗi ngày (chặn một tài khoản xin ký liên tục).
export function createAssetsRouter(options: { rateLimit: number; userHourlyLimit: number; userDailyLimit: number; cloudinary: CloudinaryConfig | null }): Router {
  const router = Router();
  router.post(
    '/sign',
    rateLimiter(options.rateLimit),
    requireAuth,
    userRateLimiter({ windowMs: HOUR, limit: options.userHourlyLimit }),
    userRateLimiter({ windowMs: DAY, limit: options.userDailyLimit }),
    createSignHandler(options.cloudinary),
  );
  return router;
}
