import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type ErrorCode } from '../shared/errors';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

const send = (res: Parameters<ErrorRequestHandler>[2], status: number, code: ErrorCode, message: string, details?: unknown) => {
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  send(res, 404, 'NOT_FOUND', 'Route not found');
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return send(res, STATUS[err.code], err.code, err.message, err.details);
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return send(res, 400, 'VALIDATION', 'Invalid request', details);
  }

  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return send(res, 400, 'VALIDATION', 'Invalid JSON body');
  if (type === 'entity.too.large') return send(res, 413, 'VALIDATION', 'Request body too large');

  req.log.error({ err }, 'unhandled error');
  send(res, 500, 'INTERNAL', 'Internal server error');
};
