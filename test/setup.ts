import { inject } from 'vitest';

// Chạy trước mỗi file test, trước khi app được import (env.ts đọc process.env lúc import).
// `.env` của dự án trỏ vào Atlas thật và Redis của máy có dự án khác, nên từ chối chạy nếu địa chỉ không phải của test.
const databaseUrl = inject('databaseUrl' as never) as string | undefined;
const redisUrl = inject('redisUrl' as never) as string | undefined;

const parse = (value: string | undefined): URL | undefined => {
  try {
    return new URL(value ?? '');
  } catch {
    return undefined;
  }
};

const db = parse(databaseUrl);
if (!databaseUrl || !db || !['127.0.0.1', 'localhost'].includes(db.hostname) || !databaseUrl.includes('/cmbe_test')) {
  throw new Error('Refusing to run tests: DATABASE_URL is not the local in-memory test database.');
}

const redis = parse(redisUrl);
if (!redisUrl || !redis || redis.hostname !== '127.0.0.1' || !redis.port || redis.port === '6379') {
  throw new Error('Refusing to run tests: REDIS_URL is not a temporary local Redis (never the default port 6379).');
}

// Test không bao giờ được gửi mail thật: biến môi trường của shell vẫn lọt vào test dù .env không được nạp.
if (process.env.MAIL_TRANSPORT === 'gmail') {
  throw new Error('Refusing to run tests: MAIL_TRANSPORT=gmail would send real email.');
}
delete process.env.GMAIL_USER;
delete process.env.GMAIL_APP_PASSWORD;

Object.assign(process.env, {
  MAIL_TRANSPORT: 'log',
  FRONTEND_URL: 'http://localhost:3001',
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: 'cmbe-test',
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-for-vitest-only-0123456789',
  JWT_ISSUER: 'cmbe',
  JWT_AUDIENCE: 'cmbe-clients',
  CORS_ORIGINS: 'http://localhost:3001',
  LOG_LEVEL: 'silent',
  AUTH_RATE_LIMIT: '1000',
});
