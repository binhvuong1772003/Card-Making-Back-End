import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { rateLimiter } from '../../../http/rate-limit';
import { validateBody, validateQuery } from '../../../http/validate';
import { AppError } from '../../../shared/errors';
import { parseCardId } from '../cards.schema';
import { entriesQuery, formInput, type FormInput } from './responses.schema';
import { exportFormCsv, listPublicEntries, submitForm } from './responses.service';

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

const postForm: RequestHandler = async (req, res) => {
  res.status(201).json(await submitForm(slugOf(req), res.locals.body as FormInput, { ip: req.ip ?? '' }));
};

const getEntries: RequestHandler = async (req, res) => {
  const query = res.locals.query as { blockId: string; first: number; after?: string };
  const page = await listPublicEntries(slugOf(req), query.blockId, { first: query.first, after: query.after });
  // Lời mới hiện sau vài giây là đủ; lưu tạm ngắn để một thiệp nhiều người xem không dội thẳng vào cơ sở dữ liệu.
  res.set('Cache-Control', 'public, max-age=10');
  res.json(page);
};

// Công khai, không cần đăng nhập, nằm dưới /publications/:slug cùng với trang công khai (module `publications`, chỉ đọc).
export function createResponsesRouter(options: { publicRateLimit: number; formsHourlyLimit: number }): Router {
  const router = Router();
  router.post('/:slug/forms', rateLimiter(options.publicRateLimit), perIpAndSlug(options.formsHourlyLimit), validateBody(formInput), postForm);
  router.get('/:slug/forms/entries', rateLimiter(options.publicRateLimit), validateQuery(entriesQuery), getEntries);
  return router;
}

// Chạy SAU requireAuth (app.ts gắn): res.locals.auth.userId do nó đặt. Tệp CSV UTF-8 có BOM, không cho lưu tạm vì có câu trả lời của khách.
export const formResponsesCsv: RequestHandler = async (req: Request, res: Response) => {
  const userId = res.locals.auth?.userId;
  if (typeof userId !== 'string') throw new AppError('UNAUTHENTICATED', 'Authentication required');
  const { csv, filename } = await exportFormCsv(userId, parseCardId(req.params.id), String(req.params.blockId));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.send(csv);
};
