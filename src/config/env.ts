import dotenv from 'dotenv';
import { z } from 'zod';

// Biến đã có sẵn trong môi trường (ví dụ do test đặt) luôn thắng file .env.
dotenv.config({ quiet: true });

const duration = z.string().regex(/^\d+[smhd]$/, 'use a number followed by s, m, h or d, for example 15m');

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const toMs = (value: string): number => Number(value.slice(0, -1)) * UNIT_MS[value.at(-1) as keyof typeof UNIT_MS];

const parseTrustProxy = (value: string): boolean | number | string => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // ví dụ "loopback"
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('cmbe'),
  JWT_AUDIENCE: z.string().min(1).default('cmbe-clients'),
  ACCESS_TOKEN_TTL: duration.default('15m'),
  REFRESH_TOKEN_TTL: duration.default('30d'),
  SESSION_MAX_AGE: duration.default('90d'),
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
  TRUST_PROXY: z.string().default('false'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment:\n${lines.join('\n')}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  CORS_ORIGINS: raw.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  TRUST_PROXY: parseTrustProxy(raw.TRUST_PROXY),
  isProduction: raw.NODE_ENV === 'production',
  accessTtlMs: toMs(raw.ACCESS_TOKEN_TTL),
  refreshTtlMs: toMs(raw.REFRESH_TOKEN_TTL),
  sessionMaxAgeMs: toMs(raw.SESSION_MAX_AGE),
};
