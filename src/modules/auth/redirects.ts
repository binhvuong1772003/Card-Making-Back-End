import { env } from '../../config/env';

// Chỉ nhận đường dẫn tương đối của frontend. Từ chối "//", "/\", schema (http:, javascript:), ký tự điều khiển,
// rồi kiểm tra lại bằng URL: đích phải cùng origin với FRONTEND_URL.
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/.test(value)) return null;
  try {
    return new URL(value, env.FRONTEND_URL).origin === new URL(env.FRONTEND_URL).origin ? value : null;
  } catch {
    return null;
  }
}

export type GoogleRedirectError = 'cancelled' | 'invalid_state' | 'google_failed' | 'email_unverified' | 'account_conflict' | 'server_error';

// Hợp đồng với frontend: thành công về returnTo (hoặc "/"), lỗi về /login?error=<mã chung>.
// URL chỉ mang mã chung; không có token, code hay state nào.
export const frontendRedirectUrl = (result: { error?: GoogleRedirectError; returnTo?: string | null }): string =>
  result.error
    ? `${env.FRONTEND_URL}/login?error=${result.error}`
    : `${env.FRONTEND_URL}${safeReturnPath(result.returnTo) ?? '/'}`;
