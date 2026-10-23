import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env';

// Mọi tùy chọn cookie đăng nhập nằm ở đây. SameSite đọc từ config vì phụ thuộc frontend cùng site hay khác site.
export interface CookieConfig {
  isProduction: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}

// Tiền tố __Host-/__Secure- bắt buộc Secure nên chỉ bật ở production (Safari xử lý Secure trên http://localhost không ổn).
export const cookieNames = (isProduction: boolean) =>
  isProduction
    ? { access: '__Host-access', refresh: '__Secure-refresh', googleState: '__Secure-google_oauth' }
    : { access: 'access_token', refresh: 'refresh_token', googleState: 'google_oauth' };

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

// Cookie giữ state + code_verifier của luồng Google. SameSite phải là Lax (không phải Strict): Google quay về bằng
// một lần điều hướng GET từ site khác. __Host- không dùng được vì nó bắt buộc Path=/, còn cookie này giới hạn đường dẫn.
export const GOOGLE_STATE_COOKIE_PATH = '/api/v1/auth/google';
export const GOOGLE_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export const googleStateCookieOptions = (config: CookieConfig, maxAgeMs?: number): CookieOptions => ({
  httpOnly: true,
  secure: config.isProduction,
  sameSite: 'lax',
  path: GOOGLE_STATE_COOKIE_PATH,
  ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
});

const active: CookieConfig ={ isProduction: env.isProduction, sameSite: env.COOKIE_SAMESITE };
export const names = cookieNames(active.isProduction);

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string; refreshMaxAgeMs: number },
): void {
  res.cookie(names.access, tokens.accessToken, accessCookieOptions(active, env.accessTtlMs));
  res.cookie(names.refresh, tokens.refreshToken, refreshCookieOptions(active, tokens.refreshMaxAgeMs));
}

export function setGoogleStateCookie(res: Response, value: string): void {
  res.cookie(names.googleState, value, googleStateCookieOptions(active, GOOGLE_STATE_MAX_AGE_MS));
}

// Dùng một lần: callback xóa ngay, với đúng path/thuộc tính thì trình duyệt mới thật sự xóa.
export function clearGoogleStateCookie(res: Response): void {
  res.clearCookie(names.googleState, googleStateCookieOptions(active));
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(names.access, accessCookieOptions(active));
  res.clearCookie(names.refresh, refreshCookieOptions(active));
}
