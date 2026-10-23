import { afterEach, describe, expect, it, vi } from 'vitest';

// env.ts đọc process.env lúc import, nên mỗi ca nạp lại module với giá trị biến mong muốn.
const original = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import('../src/config/env')).env;
}

afterEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

describe('environment parsing', () => {
  it('runs workers outside the API process by default', async () => {
    const env = await loadEnv({ RUN_WORKERS: undefined });
    expect(env.RUN_WORKERS).toBe(false); // phải là boolean false, không phải chuỗi 'false'
  });

  it('parses RUN_WORKERS as a real boolean', async () => {
    expect((await loadEnv({ RUN_WORKERS: 'true' })).RUN_WORKERS).toBe(true);
    expect((await loadEnv({ RUN_WORKERS: 'false' })).RUN_WORKERS).toBe(false);
  });

  it('applies the documented defaults', async () => {
    const env = await loadEnv({ QUEUE_PREFIX: undefined, COOKIE_SAMESITE: undefined, ACCESS_TOKEN_TTL: undefined, PORT: undefined });
    expect(env.QUEUE_PREFIX).toBe('cmbe');
    expect(env.COOKIE_SAMESITE).toBe('lax');
    expect(env.accessTtlMs).toBe(15 * 60 * 1000);
    expect(env.PORT).toBe(3000);
  });

  it('defaults to the log mail transport and trims the frontend URL', async () => {
    const env = await loadEnv({ MAIL_TRANSPORT: undefined, FRONTEND_URL: 'http://localhost:3001/' });
    expect(env.MAIL_TRANSPORT).toBe('log');
    expect(env.FRONTEND_URL).toBe('http://localhost:3001');
    expect(env.emailVerifyTtlMs).toBe(24 * 3_600_000);
  });

  it('requires Gmail credentials for the gmail transport and strips spaces from the app password', async () => {
    await expect(loadEnv({ MAIL_TRANSPORT: 'gmail', GMAIL_USER: undefined, GMAIL_APP_PASSWORD: undefined })).rejects.toThrow(/GMAIL_USER/);
    const env = await loadEnv({ MAIL_TRANSPORT: 'gmail', GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
    expect(env.GMAIL_APP_PASSWORD).toBe('abcdefghijklmnop');
    expect(env.mailFrom).toBe('CardMaking <me@gmail.com>');
  });

  it('keeps Google sign-in off unless both client ID and secret are set, treating empty strings as unset', async () => {
    const off = await loadEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '', PORT: '3000' });
    expect(off.googleEnabled).toBe(false);
    expect(off.GOOGLE_REDIRECT_URI).toBe('http://localhost:3000/api/v1/auth/google/callback');

    await expect(loadEnv({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: '' })).rejects.toThrow(/GOOGLE_CLIENT_SECRET/);
    await expect(loadEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'secret' })).rejects.toThrow(/GOOGLE_CLIENT_ID/);
    await expect(loadEnv({ GOOGLE_CLIENT_ID: 'not-a-google-id', GOOGLE_CLIENT_SECRET: 'secret' })).rejects.toThrow(/GOOGLE_CLIENT_ID/);

    const on = await loadEnv({ GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'http://localhost:3000/cb' });
    expect(on.googleEnabled).toBe(true);
    expect(on.GOOGLE_REDIRECT_URI).toBe('http://localhost:3000/cb');
  });

  it('refuses the log transport in production', async () => {
    await expect(loadEnv({ NODE_ENV: 'production', MAIL_TRANSPORT: 'log' })).rejects.toThrow(/MAIL_TRANSPORT/);
  });

  it('fails fast with a readable message when a required variable is missing or invalid', async () => {
    await expect(loadEnv({ JWT_SECRET: 'too-short' })).rejects.toThrow(/JWT_SECRET/);
    await expect(loadEnv({ REDIS_URL: 'http://not-redis' })).rejects.toThrow(/REDIS_URL/);
    await expect(loadEnv({ QUEUE_PREFIX: 'Bad Prefix!' })).rejects.toThrow(/QUEUE_PREFIX/);
  });
});
