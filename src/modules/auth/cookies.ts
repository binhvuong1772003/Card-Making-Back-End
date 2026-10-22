import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env';

// Mọi tùy chọn cookie đăng nhập nằm ở đây. SameSite đọc từ config vì phụ thuộc frontend cùng site hay khác site.
export interface CookieConfig {
  isProduction: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}

// Tiền tố __Host-/__Secure- bắt buộc Secure nên chỉ bật ở production (Safari xử lý Secure trên http://localhost không ổn).
export const cookieNames = (isProduction: boolean) =>
  isProduction ? { access: '__Host-access', refresh: '__Secure-refresh' } : { access: 'access_token', refresh: 'refresh_token' };

// Cookie refresh chỉ được gửi tới các endpoint auth.
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const base = (config: CookieConfig): CookieOptions => ({
  httpOnly: true,
  secure: config.isProduction || config.sameSite === 'none',
  sameSite: config.sameSite,
});

export const accessCookieOptions = (config: CookieConfig, maxAgeMs?: number): CookieOptions => ({
  ...base(config),
  path: '/', // __Host- yêu cầu Path=/
  ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
});

export const refreshCookieOptions = (config: CookieConfig, maxAgeMs?: number): CookieOptions => ({
  ...base(config),
  path: REFRESH_COOKIE_PATH,
  ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
});

const active: CookieConfig = { isProduction: env.isProduction, sameSite: env.COOKIE_SAMESITE };
export const names = cookieNames(active.isProduction);

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string; refreshMaxAgeMs: number },
): void {
  res.cookie(names.access, tokens.accessToken, accessCookieOptions(active, env.accessTtlMs));
  res.cookie(names.refresh, tokens.refreshToken, refreshCookieOptions(active, tokens.refreshMaxAgeMs));
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(names.access, accessCookieOptions(active));
  res.clearCookie(names.refresh, refreshCookieOptions(active));
}
