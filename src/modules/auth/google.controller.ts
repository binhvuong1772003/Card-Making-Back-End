import type { RequestHandler } from 'express';
import { logger } from '../../infra/logger';
import { AppError } from '../../shared/errors';
import { generateOpaqueToken } from '../../shared/opaque-token';
import { clientMeta } from './auth.controller';
import type { GoogleCallbackQuery, GoogleStartQuery } from './auth.schema';
import { clearGoogleStateCookie, names, setAuthCookies, setGoogleStateCookie } from './cookies';
import { loginWithGoogle } from './google-login.service';
import type { GoogleOAuth } from './google-oauth';
import { readGoogleState, signGoogleState, statesMatch } from './google-state';
import { frontendRedirectUrl, safeReturnPath, type GoogleRedirectError } from './redirects';

// Hai endpoint này là điều hướng của trình duyệt, không phải lời gọi API: callback LUÔN trả 302 về frontend,
// kể cả khi lỗi, kèm mã lỗi chung. Không bao giờ để rơi vào bộ xử lý lỗi JSON.
export function createGoogleHandlers(google: GoogleOAuth | null): { start: RequestHandler; callback: RequestHandler } {
  const start: RequestHandler = async (req, res) => {
    if (!google) throw new AppError('PROVIDER_UNAVAILABLE', 'Google sign-in is not configured');
    const returnTo = safeReturnPath((res.locals.query as GoogleStartQuery).returnTo);

    const state = generateOpaqueToken();
    const { codeVerifier, codeChallenge } = await google.createPkce();
    setGoogleStateCookie(res, await signGoogleState({ state, codeVerifier, returnTo }));
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, google.buildAuthUrl({ state, codeChallenge }));
  };

  const callback: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const go = (error?: GoogleRedirectError, returnTo?: string | null) => res.redirect(302, frontendRedirectUrl({ error, returnTo }));

    // Cookie state chỉ dùng một lần: đọc rồi xóa ngay, bất kể kết quả.
    const cookieValue = req.cookies?.[names.googleState] as string | undefined;
    clearGoogleStateCookie(res);

    try {
      if (!google) return go('server_error');
      const { code, state, error } = res.locals.query as GoogleCallbackQuery;
      if (error) return go(error === 'access_denied' ? 'cancelled' : 'google_failed');

      const saved = await readGoogleState(cookieValue);
      if (!saved || !code || !state || !statesMatch(state, saved.state)) return go('invalid_state');

      const claims = await google.exchangeCode({ code, codeVerifier: saved.codeVerifier });
      const { session } = await loginWithGoogle(claims, clientMeta(req));
      setAuthCookies(res, session);
      return go(undefined, saved.returnTo);
    } catch (err) {
      if (err instanceof AppError) {
        if (err.code === 'PROVIDER_EMAIL_UNVERIFIED') return go('email_unverified');
        if (err.code === 'ACCOUNT_CONFLICT') return go('account_conflict');
        if (err.code === 'PROVIDER_FAILED') return go('google_failed');
      }
      // Chỉ ghi tên và thông điệp: không ghi đối tượng lỗi nguyên vẹn (có thể mang theo dữ liệu yêu cầu).
      logger.error({ name: (err as Error)?.name, message: (err as Error)?.message }, 'google callback failed');
      return go('server_error');
    }
  };

  return { start, callback };
}
