import { randomUUID } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import argon2 from 'argon2';
import { env } from '../../config/env';
import { logger } from '../../infra/logger';
import { prisma } from '../../infra/prisma';
import { getRedis } from '../../infra/redis';
import { AppError } from '../../shared/errors';
import { generateOpaqueToken, hashOpaqueToken } from '../../shared/opaque-token';
import type { LoginBody, RegisterBody } from './auth.schema';
import { enqueueVerificationEmail } from './email.jobs';
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
  let user;
  try {
    user = await prisma.user.create({ data: { email: input.email, name: input.name, passwordHash } });
  } catch (err) {
    if (isUniqueViolation(err)) return; // email đã có: không đổi gì, không gửi mail
    throw err;
  }
  // Xếp mail xác thực SAU khi đã ghi user. Cố ý best-effort: nếu Redis lỗi thì vẫn trả cùng phản hồi để không lộ
  // gì ra ngoài. Hệ quả đã biết: user này chưa có mail và chưa có chức năng gửi lại (chưa làm).
  try {
    await enqueueVerificationEmail(user.id);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'failed to enqueue verification email');
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
  // Chỉ kiểm tra SAU khi mật khẩu đúng, nên chỉ người biết mật khẩu mới biết tài khoản chưa xác minh. Chưa tạo phiên.
  if (!user.emailVerifiedAt) {
    throw new AppError('EMAIL_NOT_VERIFIED', 'Email address is not verified');
  }
  const session = await createSession(user.id, meta);
  return { user: toPublicUser(user), session };
}

// Prisma trên MongoDB không ghi null cho trường chưa đặt, nên "chưa dùng" phải khớp cả vắng mặt lẫn null.
const UNUSED = [{ usedAt: { isSet: false } }, { usedAt: null }];

const isWriteConflict = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

// Dùng token xác nhận đúng một lần. Gọi lại với token đã dùng (bấm đôi, bộ quét thư) vẫn thành công nếu email đã
// được xác minh, nên chức năng này idempotent. Không tạo phiên: link có thể mở trên thiết bị khác.
export async function verifyEmail(token: string): Promise<void> {
  const tokenHash = hashOpaqueToken(token);
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash } });
  if (!record || record.purpose !== 'EMAIL_VERIFY') throw new AppError('TOKEN_INVALID', 'Verification link is not valid');

  // Đổi email sau khi nhận link thì link cũ hết tác dụng.
  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user || user.email !== record.email) throw new AppError('TOKEN_INVALID', 'Verification link is not valid');
  if (user.emailVerifiedAt) return;

  const now = new Date();
  if (record.expiresAt <= now) throw new AppError('TOKEN_EXPIRED', 'Verification link has expired');

  try {
    await prisma.$transaction(async (tx) => {
      // Điều kiện nằm ngay trong lệnh ghi: hai request cùng token thì chỉ một bên dùng được (count === 1).
      const consumed = await tx.verificationToken.updateMany({
        where: { tokenHash, purpose: 'EMAIL_VERIFY', expiresAt: { gt: now }, OR: UNUSED },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) return;
      await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
      // Các link gửi lại trước đó không còn cần nữa.
      await tx.verificationToken.updateMany({
        where: { userId: user.id, purpose: 'EMAIL_VERIFY', OR: UNUSED },
        data: { usedAt: now },
      });
    });
  } catch (err) {
    // Hai request chạm nhau thì bên thua nhận lỗi xung đột ghi; kết quả đúng hay không được quyết định bên dưới.
    if (!isWriteConflict(err)) throw err;
  }

  const after = await prisma.user.findUnique({ where: { id: user.id } });
  if (!after?.emailVerifiedAt) throw new AppError('TOKEN_INVALID', 'Verification link is not valid');
}

const RESEND_COOLDOWN_SECONDS = 60;

// Luôn cho cùng một kết quả dù email có tồn tại, đã xác minh hay chưa. Chỉ tài khoản có thật và chưa xác minh mới
// xếp job, và mỗi tài khoản chỉ được gửi lại một lần mỗi 60 giây để không ai dùng chức năng này làm ngập hộp thư.
export async function resendVerification(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.emailVerifiedAt) return;
  try {
    const redis = await getRedis();
    const free = await redis.set(`${env.QUEUE_PREFIX}:cooldown:verify-email:${user.id}`, '1', 'EX', RESEND_COOLDOWN_SECONDS, 'NX');
    if (!free) return;
    await enqueueVerificationEmail(user.id, { resend: true });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'failed to resend verification email');
  }
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
