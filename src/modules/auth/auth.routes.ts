import { Router } from 'express';
import { rateLimiter } from '../../http/rate-limit';
import { validateBody, validateQuery } from '../../http/validate';
import { googleCallbackQuery, googleStartQuery, loginBody, registerBody, resendVerificationBody, verifyEmailBody } from './auth.schema';
import * as controller from './auth.controller';
import { requireAuth } from './auth.middleware';
import { createGoogleHandlers } from './google.controller';
import type { GoogleOAuth } from './google-oauth';

export function createAuthRouter(options: { rateLimit: number; google: GoogleOAuth | null }): Router {
  const router = Router();
  const google = createGoogleHandlers(options.google);
  router.get('/google/start', rateLimiter(options.rateLimit), validateQuery(googleStartQuery), google.start);
  // Không giới hạn tốc độ ở callback: nó phải luôn trả 302 (không phải JSON 429), và chỉ state hợp lệ do `start` cấp
  // (đã bị giới hạn) mới dẫn tới một lần gọi Google.
  router.get('/google/callback', validateQuery(googleCallbackQuery), google.callback);
  router.post('/register', rateLimiter(options.rateLimit), validateBody(registerBody), controller.register);
  router.post('/login', rateLimiter(options.rateLimit), validateBody(loginBody), controller.login);
  router.post('/verify-email', rateLimiter(options.rateLimit), validateBody(verifyEmailBody), controller.verifyEmail);
  router.post('/resend-verification', rateLimiter(options.rateLimit), validateBody(resendVerificationBody), controller.resendVerification);
  // Refresh được gọi đều đặn (mỗi ~15 phút mỗi thiết bị), nhiều người sau một NAT, nên giới hạn nới hơn đăng nhập.
  router.post('/refresh', rateLimiter(options.rateLimit * 10), controller.refresh);
  router.get('/me', requireAuth, controller.me);
  router.post('/logout', controller.logout);
  router.post('/logout-all', requireAuth, controller.logoutAll);
  return router;
}
