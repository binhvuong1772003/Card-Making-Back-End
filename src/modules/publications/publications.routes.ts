import { Router } from 'express';
import { rateLimiter } from '../../http/rate-limit';
import { getPage } from './publications.controller';

// Đọc công khai, không cần đăng nhập. Chỉ đọc: ghi Publication nằm ở module cards.
export function createPublicationsRouter(options: { rateLimit: number }): Router {
  const router = Router();
  router.get('/:slug', rateLimiter(options.rateLimit), getPage);
  return router;
}
