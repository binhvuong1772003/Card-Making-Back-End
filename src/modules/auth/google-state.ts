import { timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env';

// Giá trị của cookie state: JWT ký bằng cùng khóa với access token nhưng audience RIÊNG, nên không bao giờ
// xác minh được như một access token (và ngược lại).
const AUDIENCE = 'cmbe-google-oauth';
const key = new TextEncoder().encode(env.JWT_SECRET);

export interface GoogleState {
  state: string;
  codeVerifier: string;
  returnTo: string | null;
}

export const signGoogleState = (payload: GoogleState): Promise<string> =>
  new SignJWT({ cv: payload.codeVerifier, rt: payload.returnTo })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.state)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);

// Trả null cho mọi trường hợp không hợp lệ (thiếu, giả mạo, hết hạn, sai audience).
export async function readGoogleState(value: string | undefined): Promise<GoogleState | null> {
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, key, { algorithms: ['HS256'], issuer: env.JWT_ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== 'string' || typeof payload.cv !== 'string') return null;
    return { state: payload.sub, codeVerifier: payload.cv, returnTo: typeof payload.rt === 'string' ? payload.rt : null };
  } catch {
    return null;
  }
}

// So sánh thời gian cố định; kiểm tra độ dài trước vì timingSafeEqual ném lỗi khi lệch độ dài.
export function statesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
