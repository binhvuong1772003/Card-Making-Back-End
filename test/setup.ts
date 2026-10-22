import { inject } from 'vitest';

// Chạy trước mỗi file test, trước khi app được import (env.ts đọc process.env lúc import).
// `.env` của dự án trỏ vào Atlas thật, nên từ chối chạy nếu địa chỉ không phải MongoDB cục bộ của test.
const url = inject('databaseUrl' as never) as string | undefined;

const hostname = (() => {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
})();

if (!url || !['127.0.0.1', 'localhost'].includes(hostname) || !url.includes('/cmbe_test')) {
  throw new Error('Refusing to run tests: DATABASE_URL is not the local in-memory test database.');
}

Object.assign(process.env, {
  DATABASE_URL: url,
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-for-vitest-only-0123456789',
  JWT_ISSUER: 'cmbe',
  JWT_AUDIENCE: 'cmbe-clients',
  CORS_ORIGINS: 'http://localhost:3001',
  LOG_LEVEL: 'silent',
  AUTH_RATE_LIMIT: '1000',
});
