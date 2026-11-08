import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { rateLimiter } from '../../../http/rate-limit';
import { validateBody, validateQuery } from '../../../http/validate';
import { AppError } from '../../../shared/errors';
import { parseCardId } from '../cards.schema';
import { guestbookInput, guestbookQuery, rsvpInput, type GuestbookInput, type RsvpInput } from './responses.schema';
import { exportRsvpsCsv, listGuestbook, submitGuestbook, submitRsvp } from './responses.service';

const HOUR = 60 * 60 * 1000;

// Giới hạn theo IP VÀ theo thiệp: một IP gửi liên tục vào một thiệp bị chặn, nhưng không ảnh hưởng việc gửi vào thiệp khác. Kho trong bộ nhớ như
// các giới hạn khác (một instance); chuyển sang Redis khi chạy nhiều instance. `ipKeyGenerator` gộp IPv6 về nhóm /56 để không né bằng cách đổi đuôi.
const perIpAndSlug = (limit: number) =>
  rateLimit({
    windowMs: HOUR,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${String(req.params.slug)}`,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED', 'Too many attempts, try again later')),
  });

const slugOf = (req: Request): string => String(req.params.slug);

const postRsvp: RequestHandler = async (req, res) => {
  res.status(201).json(await submitRsvp(slugOf(req), res.locals.body as RsvpInput, { ip: req.ip ?? '' }));
};

const postGuestbook: RequestHandler = async (req, res) => {
  const result = await submitGuestbook(slugOf(req), res.locals.body as GuestbookInput, { ip: req.ip ?? '' });
  res.status(201).json(result);
};

const getGuestbook: RequestHandler = async (req, res) => {
  const query = res.locals.query as { blockId: string; first: number; after?: string };
  const page = await listGuestbook(slugOf(req), query.blockId, { first: query.first, after: query.after });
  // Lời chúc mới hiện sau vài giây là đủ; lưu tạm ngắn để một thiệp nhiều người xem không dội thẳng vào cơ sở dữ liệu.
  res.set('Cache-Control', 'public, max-age=10');
  res.json(page);
};

// Công khai, không cần đăng nhập, nằm dưới /publications/:slug cùng với trang công khai (module `publications`, chỉ đọc).
export function createResponsesRouter(options: { publicRateLimit: number; rsvpHourlyLimit: number; guestbookHourlyLimit: number }): Router {
  const router = Router();
  router.post('/:slug/rsvps', rateLimiter(options.publicRateLimit), perIpAndSlug(options.rsvpHourlyLimit), validateBody(rsvpInput), postRsvp);
  router.post('/:slug/guestbook', rateLimiter(options.publicRateLimit), perIpAndSlug(options.guestbookHourlyLimit), validateBody(guestbookInput), postGuestbook);
  router.get('/:slug/guestbook', rateLimiter(options.publicRateLimit), validateQuery(guestbookQuery), getGuestbook);
  return router;
}

// Chạy SAU requireAuth (app.ts gắn): res.locals.auth.userId do nó đặt. Tệp CSV UTF-8 có BOM, không cho lưu tạm vì có tên và số điện thoại của khách.
export const rsvpsCsv: RequestHandler = async (req: Request, res: Response) => {
  const userId = res.locals.auth?.userId;
  if (typeof userId !== 'string') throw new AppError('UNAUTHENTICATED', 'Authentication required');
  const csv = await exportRsvpsCsv(userId, parseCardId(req.params.id));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="xac-nhan-tham-du.csv"', 'Cache-Control': 'no-store' });
  res.send(csv);
};
