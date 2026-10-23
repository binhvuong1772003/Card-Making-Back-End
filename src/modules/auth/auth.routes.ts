import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { validateBody, validateQuery } from '../../http/validate';
import { AppError } from '../../shared/errors';
import { googleCallbackQuery, googleStartQuery, loginBody, registerBody, resendVerificationBody, verifyEmailBody } from './auth.schema';
import * as controller from './auth.controller';
import { requireAuth } from './auth.middleware';
import { createGoogleHandlers } from './google.controller';
import type { GoogleOAuth } from './google-oauth';

// Giới hạn theo IP, kho trong bộ nhớ (một instance); chuyển sang Redis khi chạy nhiều instance.
const limiter = (limit: number) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 'Too many attempts, try again later')),
  });

export function createAuthRouter(options: { rateLimit: number; google: GoogleOAuth | null }): Router {
  const router = Router();
  const google = createGoogleHandlers(options.google);
  router.get('/google/start', limiter(options.rateLimit), validateQuery(googleStartQuery), google.start);
  // Không giới hạn tốc độ ở callback: nó phải luôn trả 302 (không phải JSON 429), và chỉ state hợp lệ do `start` cấp
  // (đã bị giới hạn) mới dẫn tới một lần gọi Google.
  router.get('/google/callback', validateQuery(googleCallbackQuery), google.callback);
  router.post('/register', limiter(options.rateLimit), validateBody(registerBody), controller.register);
  router.post('/login', limiter(options.rateLimit), validateBody(loginBody), controller.login);
  router.post('/verify-email', limiter(options.rateLimit), validateBody(verifyEmailBody), controller.verifyEmail);
  router.post('/resend-verification', limiter(options.rateLimit), validateBody(resendVerificationBody), controller.resendVerification);
  // Refresh được gọi đều đặn (mỗi ~15 phút mỗi thiết bị), nhiều người sau một NAT, nên giới hạn nới hơn đăng nhập.
  router.post('/refresh', limiter(options.rateLimit * 10), controller.refresh);
  router.get('/me', requireAuth, controller.me);
  router.post('/logout', controller.logout);
  router.post('/logout-all', requireAuth, controller.logoutAll);
  return router;
}
