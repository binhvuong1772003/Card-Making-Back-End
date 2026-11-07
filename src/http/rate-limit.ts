import { rateLimit } from 'express-rate-limit';
import { AppError } from '../shared/errors';

// Giới hạn theo IP trong 15 phút, kho trong bộ nhớ (một instance); chuyển sang Redis khi chạy nhiều instance.
export const rateLimiter = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 'Too many attempts, try again later')),
  });

// Giới hạn theo từng người dùng đã đăng nhập (chạy SAU requireAuth): không lách được bằng cách đổi IP, và nhiều người dùng chung một
// IP không ảnh hưởng nhau. Kho trong bộ nhớ như `rateLimiter`.
export const userRateLimiter = (options: { windowMs: number; limit: number }) =>
  rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (_req, res) => String(res.locals.auth?.userId ?? 'anonymous'),
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 'Too many attempts, try again later')),
  });
