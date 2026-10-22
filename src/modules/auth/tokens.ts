import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env';
import { AppError } from '../../shared/errors';

const key = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessPrincipal {
  userId: string;
  sessionId: string;
  exp: number;
}

export const signAccessToken = (input: { userId: string; sessionId: string }): Promise<string> =>
  new SignJWT({ sid: input.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(key);

export async function verifyAccessToken(token: string): Promise<AccessPrincipal> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.exp !== 'number') {
      throw new Error('malformed claims');
    }
    return { userId: payload.sub, sessionId: payload.sid, exp: payload.exp };
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired token');
  }
}
