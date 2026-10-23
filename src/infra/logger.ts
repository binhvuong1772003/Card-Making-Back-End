import pino from 'pino';
import { env } from '../config/env';

// Query string có thể mang `code` và `state` của Google (callback) nên không bao giờ được ghi vào log: chỉ giữ đường dẫn.
export const requestSerializer = (req: { id?: unknown; method?: string; url?: string; originalUrl?: string; raw?: { originalUrl?: string; url?: string } }) => {
  const url = req.originalUrl ?? req.raw?.originalUrl ?? req.url ?? req.raw?.url ?? '';
  return { id: req.id, method: req.method, url: url.split('?')[0] };
};

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    // `Location` của phản hồi 302 về Google chứa state và code_challenge.
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'res.headers.location'],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
