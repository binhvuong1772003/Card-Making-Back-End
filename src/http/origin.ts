import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { AppError } from '../shared/errors';

// Không có header Origin (curl, kiểm thử, MCP) thì cho qua; có mà không nằm trong danh sách thì từ chối.
export const isAllowedOrigin = (origin: string | undefined): boolean =>
  origin === undefined || env.CORS_ORIGINS.includes(origin);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const originCheck: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || isAllowedOrigin(req.get('origin'))) return next();
  next(new AppError('FORBIDDEN', 'Origin not allowed'));
};
