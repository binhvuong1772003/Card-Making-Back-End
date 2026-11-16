import type { RequestHandler } from 'express';
import { Router } from 'express';
import { rateLimiter } from '../../../http/rate-limit';
import { publicGuest, recordGuestOpen } from './guests.service';

const slugOf = (req: Parameters<RequestHandler>[0]): string => String(req.params.slug);
const codeOf = (req: Parameters<RequestHandler>[0]): string => String(req.params.code);

const getGuest: RequestHandler = async (req, res) => {
  // Không lưu tạm: tên khách là dữ liệu riêng, mỗi mã một nội dung.
  res.set('Cache-Control', 'no-store');
  res.json(await publicGuest(slugOf(req), codeOf(req)));
};

const postOpen: RequestHandler = async (req, res) => {
  await recordGuestOpen(slugOf(req), codeOf(req));
  res.status(204).end();
};

// Công khai, không cần đăng nhập, dưới /publications/:slug cùng với trang công khai.
export function createGuestsRouter(options: { publicRateLimit: number }): Router {
  const router = Router();
  router.get('/:slug/guest/:code', rateLimiter(options.publicRateLimit), getGuest);
  router.post('/:slug/guest/:code/open', rateLimiter(options.publicRateLimit), postOpen);
  return router;
}
