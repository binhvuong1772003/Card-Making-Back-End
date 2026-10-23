import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

// Giá trị đã kiểm tra đặt vào res.locals.body (Express 5: req.query chỉ đọc nên không gán đè req.*).
export const validateBody =
  (schema: ZodType): RequestHandler =>
  (req, res, next) => {
    res.locals.body = schema.parse(req.body);
    next();
  };

// Tương tự cho query string, đặt vào res.locals.query.
export const validateQuery =
  (schema: ZodType): RequestHandler =>
  (req, res, next) => {
    res.locals.query = schema.parse(req.query);
    next();
  };
