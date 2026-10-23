import dotenv from 'dotenv';
import { z } from 'zod';

// Biến đã có sẵn trong môi trường luôn thắng file .env. Khi chạy test thì không nạp .env: nó trỏ vào Atlas thật.
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });

const duration = z.string().regex(/^\d+[smhd]$/, 'use a number followed by s, m, h or d, for example 15m');

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const toMs = (value: string): number => Number(value.slice(0, -1)) * UNIT_MS[value.at(-1) as keyof typeof UNIT_MS];

// .env.example có dòng KEY= để trống; dotenv trả chuỗi rỗng, phải coi như chưa đặt.
const emptyAsUnset = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const parseTrustProxy =(value: string): boolean | number | string => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // ví dụ "loopback"
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z
    .string()
    .refine((value) => /^rediss?:\/\//.test(value) && URL.canParse(value), 'must be a redis:// or rediss:// URL'),
  // Tiền tố khóa riêng cho mọi hàng đợi BullMQ: Redis dùng chung với dự án khác không được lẫn job.
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes')
    .default('cmbe'),
  // Worker mặc định là tiến trình riêng (npm run start:worker). true chỉ để tiện chạy chung với API khi phát triển.
  // Zod 4: .default() trả giá trị mặc định nguyên văn và bỏ qua transform đứng sau, nên default phải đặt SAU transform.
  RUN_WORKERS: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
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

  // Gửi email. `log` chỉ ghi ra log (dev); `gmail` gửi thật qua SMTP của Gmail bằng App Password.
  MAIL_TRANSPORT: z.enum(['log', 'gmail']).default('log'),
  GMAIL_USER: z.email().optional(),
  // App Password hiển thị dạng bốn nhóm bốn chữ cái cách nhau bằng dấu cách; bỏ hết khoảng trắng.
  GMAIL_APP_PASSWORD: z
    .string()
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().min(1))
    .optional(),
  MAIL_FROM: z.string().min(1).optional(),
  // Địa chỉ trang frontend, dùng để dựng link trong email.
  FRONTEND_URL: z
    .string()
    .refine((value) => /^https?:\/\//.test(value) && URL.canParse(value), 'must be an http(s) URL')
    .default('http://localhost:3001'),
  EMAIL_VERIFY_TTL: duration.default('24h'),

  // Đăng nhập Google (luồng chuyển hướng). Để trống cả ID lẫn secret thì tính năng tắt (start trả 503).
  GOOGLE_CLIENT_ID: emptyAsUnset(z.string().regex(/\.apps\.googleusercontent\.com$/, 'must end with .apps.googleusercontent.com')),
  GOOGLE_CLIENT_SECRET: emptyAsUnset(z.string().min(1)),
  // Địa chỉ callback đăng ký trong Google Cloud Console; cố định trong cấu hình, không bao giờ dựng từ header Host.
  GOOGLE_REDIRECT_URI: emptyAsUnset(
    z.string().refine((value) => /^https?:\/\//.test(value) && URL.canParse(value), 'must be an http(s) URL'),
  ),
}).superRefine((value, ctx) => {
  if (Boolean(value.GOOGLE_CLIENT_ID) !== Boolean(value.GOOGLE_CLIENT_SECRET)) {
    const missing = value.GOOGLE_CLIENT_ID ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID';
    ctx.addIssue({ code: 'custom', path: [missing], message: 'is required when the other Google variable is set' });
  }
  if (value.MAIL_TRANSPORT === 'gmail') {
    for (const key of ['GMAIL_USER', 'GMAIL_APP_PASSWORD'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required when MAIL_TRANSPORT=gmail' });
    }
  }
  // Ở production mà dùng log thì email xác thực bị bỏ rơi trong im lặng; thà không khởi động.
  if (value.NODE_ENV === 'production' && value.MAIL_TRANSPORT === 'log') {
    ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: 'the log transport drops emails; use gmail in production' });
  }
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
  emailVerifyTtlMs: toMs(raw.EMAIL_VERIFY_TTL),
  googleEnabled: Boolean(raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET),
  GOOGLE_REDIRECT_URI: raw.GOOGLE_REDIRECT_URI ?? `http://localhost:${raw.PORT}/api/v1/auth/google/callback`,
  FRONTEND_URL: raw.FRONTEND_URL.replace(/\/+$/, ''),
  // Gmail luôn ghi đè From bằng chính tài khoản đã đăng nhập, nên mặc định dùng đúng địa chỉ đó.
  mailFrom: raw.MAIL_FROM ?? (raw.GMAIL_USER ? `CardMaking <${raw.GMAIL_USER}>` : 'CardMaking <no-reply@localhost>'),
};
