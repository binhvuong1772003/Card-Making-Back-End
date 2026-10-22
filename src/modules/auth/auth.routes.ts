import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { validateBody } from '../../http/validate';
import { AppError } from '../../shared/errors';
import { loginBody, registerBody, resendVerificationBody, verifyEmailBody } from './auth.schema';
import * as controller from './auth.controller';
import { requireAuth } from './auth.middleware';

// Giới hạn theo IP, kho trong bộ nhớ (một instance); chuyển sang Redis khi chạy nhiều instance.
const limiter = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 'Too many attempts, try again later')),
  });

export function createAuthRouter(options: { rateLimit: number }): Router {
  const router = Router();
  router.post('/register', limiter(options.rateLimit), validateBody(registerBody), controller.register);
  router.post('/login', limiter(options.rateLimit), validateBody(loginBody), controller.login);
  router.post('/verify-email', limiter(options.rateLimit), validateBody(verifyEmailBody), controller.verifyEmail);
  router.post('/resend-verification', limiter(options.rateLimit), validateBody(resendVerificationBody), controller.resendVerification);
  router.get('/me', requireAuth, controller.me);
  router.post('/logout', controller.logout);
  return router;
}
