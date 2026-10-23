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
