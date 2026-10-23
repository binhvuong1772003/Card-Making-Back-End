import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env';
import { logger } from '../../infra/logger';
import { AppError } from '../../shared/errors';

// Danh tính đã chuẩn hóa lấy từ id_token của Google; không giữ lại bất kỳ token nào.
export interface GoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

// Giao diện được tiêm vào createApp để test thay bằng bản giả, không gọi mạng.
export interface GoogleOAuth {
  createPkce(): Promise<{ codeVerifier: string; codeChallenge: string }>;
  buildAuthUrl(input: { state: string; codeChallenge: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<GoogleClaims>;
}

const CALL_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('google request timed out')), CALL_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createGoogleOAuth(config: GoogleOAuthConfig, client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri)): GoogleOAuth {
  return {
    async createPkce() {
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
      if (!codeChallenge) throw new AppError('PROVIDER_FAILED', 'Could not create the PKCE challenge');
      return { codeVerifier, codeChallenge };
    },

    // Chỉ xin danh tính: không access_type=offline, không ép màn hình đồng ý (prompt=select_account).
    buildAuthUrl({ state, codeChallenge }) {
      return client.generateAuthUrl({
        redirect_uri: config.redirectUri,
        scope: ['openid', 'email', 'profile'],
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        prompt: 'select_account',
      });
    },

    async exchangeCode({ code, codeVerifier }) {
      try {
        const { tokens } = await withTimeout(client.getToken({ code, codeVerifier, redirect_uri: config.redirectUri }));
        if (!tokens.id_token) throw new Error('missing id_token');
        // verifyIdToken kiểm tra chữ ký, aud, iss và exp.
        const ticket = await withTimeout(client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId }));
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email) throw new Error('id_token has no subject or email');
        return {
          sub: payload.sub,
          email: payload.email,
          emailVerified: payload.email_verified === true,
          name: payload.name ?? null,
          picture: payload.picture ?? null,
        };
      } catch (err) {
        // Chỉ ghi lý do: lỗi của thư viện HTTP có thể mang theo cấu hình yêu cầu, trong đó có client_secret.
        logger.warn({ reason: err instanceof Error ? err.message : 'unknown' }, 'google code exchange failed');
        throw new AppError('PROVIDER_FAILED', 'Google sign-in failed');
      }
    },
  };
}

// Bộ thật khi đã cấu hình; null khi tính năng tắt (start trả 503).
export const defaultGoogleOAuth = (): GoogleOAuth | null =>
  env.googleEnabled
    ? createGoogleOAuth({ clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, redirectUri: env.GOOGLE_REDIRECT_URI })
    : null;
