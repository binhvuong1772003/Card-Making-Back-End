import { randomUUID } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import argon2 from 'argon2';
import { env } from '../../config/env';
import { prisma } from '../../infra/prisma';
import { AppError } from '../../shared/errors';
import { generateOpaqueToken, hashOpaqueToken } from '../../shared/opaque-token';
import type { LoginBody, RegisterBody } from './auth.schema';
import { signAccessToken } from './tokens';

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
  createdAt: Date;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeMs: number;
}

const toPublicUser = (user: Pick<User, 'id' | 'email' | 'name' | 'avatarUrl' | 'emailVerifiedAt' | 'createdAt'>): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: user.avatarUrl,
  emailVerified: user.emailVerifiedAt !== null,
  createdAt: user.createdAt,
});

// Băm giả để đăng nhập với email lạ (hoặc tài khoản không có mật khẩu) tốn thời gian như trường hợp thật.
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => (dummyHash ??= argon2.hash(randomUUID()));

// Gọi lúc khởi động để lần đăng nhập đầu tiên với email lạ không phải trả thêm một lần băm.
export const warmUp = async (): Promise<void> => {
  await getDummyHash();
};

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Đăng ký luôn cho cùng một kết quả dù email đã tồn tại hay chưa (không lộ email nào đã đăng ký) và
// không bao giờ sửa một User có sẵn, kể cả tài khoản chỉ có Google. Việc chống trùng dựa vào chỉ mục duy nhất.
export async function register(input: RegisterBody): Promise<void> {
  const passwordHash = await argon2.hash(input.password);
  try {
    await prisma.user.create({ data: { email: input.email, name: input.name, passwordHash } });
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

// Một lần đăng nhập = một họ phiên (familyId). Refresh và Google sau này dùng lại hàm này.
export async function createSession(
  userId: string,
  meta: SessionMeta,
  family?: { familyId: string; familyStartedAt: Date },
): Promise<IssuedSession> {
  const now = Date.now();
  const familyId = family?.familyId ?? randomUUID();
  const familyStartedAt = family?.familyStartedAt ?? new Date(now);
  const expiresAt = Math.min(now + env.refreshTtlMs, familyStartedAt.getTime() + env.sessionMaxAgeMs);

  const refreshToken = generateOpaqueToken();
  const session = await prisma.session.create({
    data: {
      userId,
      familyId,
      tokenHash: hashOpaqueToken(refreshToken),
      familyStartedAt,
      expiresAt: new Date(expiresAt),
      userAgent: meta.userAgent,
      ip: meta.ip,
    },
  });
  const accessToken = await signAccessToken({ userId, sessionId: session.id });
  return { accessToken, refreshToken, refreshMaxAgeMs: expiresAt - now };
}

export async function login(input: LoginBody, meta: SessionMeta): Promise<{ user: PublicUser; session: IssuedSession }> {
  const user = await prisma.user.findUnique({ where: { email: input.email }, omit: { passwordHash: false } });
  const verified = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password);
  // Email lạ, sai mật khẩu và tài khoản không có mật khẩu đều cho cùng một lỗi.
  if (!user || !user.passwordHash || !verified) {
    throw new AppError('UNAUTHENTICATED', 'Invalid email or password');
  }
  const session = await createSession(user.id, meta);
  return { user: toPublicUser(user), session };
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
  return toPublicUser(user);
}

// Thu hồi cả họ phiên của lần đăng nhập này. Không có cookie hay token lạ thì không làm gì.
export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  const session = await prisma.session.findUnique({ where: { tokenHash: hashOpaqueToken(refreshToken) } });
  if (!session) return;
  // Prisma trên MongoDB không ghi null cho trường tùy chọn chưa đặt, nên "chưa thu hồi" phải khớp cả vắng mặt lẫn null.
  await prisma.session.updateMany({
    where: { familyId: session.familyId, OR: [{ revokedAt: { isSet: false } }, { revokedAt: null }] },
    data: { revokedAt: new Date() },
  });
}
