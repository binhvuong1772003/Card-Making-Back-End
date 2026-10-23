import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../infra/prisma';
import { AppError } from '../../shared/errors';
import { createSession, toPublicUser, type IssuedSession, type PublicUser, type SessionMeta } from './auth.service';
import type { GoogleClaims } from './google-oauth';

type UserRow = Pick<User, 'id' | 'email' | 'name' | 'avatarUrl' | 'emailVerifiedAt' | 'createdAt'>;

// Prisma trên MongoDB không ghi null cho trường chưa đặt, nên "chưa dùng/chưa thu hồi" phải khớp cả vắng mặt lẫn null.
const NOT_USED = [{ usedAt: { isSet: false } }, { usedAt: null }];
const NOT_REVOKED = [{ revokedAt: { isSet: false } }, { revokedAt: null }];

// Hai lần đăng nhập Google đầu tiên chạy song song: bên thua gặp trùng khóa duy nhất (P2002) hoặc xung đột ghi (P2034).
const isRetryable = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2002' || err.code === 'P2034');

// Chỉ điền khi đang trống. KHÔNG BAO GIỜ ghi đè User.email từ token: email phía Google có thể đổi hoặc bị tái sử dụng.
async function fillProfile(user: UserRow, claims: GoogleClaims): Promise<UserRow> {
  const data: Prisma.UserUpdateInput = {};
  if (!user.name && claims.name) data.name = claims.name;
  if (!user.avatarUrl && claims.picture) data.avatarUrl = claims.picture;
  return Object.keys(data).length > 0 ? prisma.user.update({ where: { id: user.id }, data }) : user;
}

async function resolveUser(claims: GoogleClaims, email: string): Promise<UserRow> {
  // 1. Đã có danh tính Google với sub này: đăng nhập đúng người đó.
  const identity = await prisma.identity.findUnique({
    where: { provider_providerAccountId: { provider: 'GOOGLE', providerAccountId: claims.sub } },
    include: { user: true },
  });
  if (identity) return fillProfile(identity.user, claims);

  // 2. Chưa có tài khoản nào với email này: tạo mới (email đã được Google xác minh).
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    return prisma.user.create({
      data: {
        email,
        name: claims.name,
        avatarUrl: claims.picture,
        emailVerifiedAt: new Date(),
        identities: { create: { provider: 'GOOGLE', providerAccountId: claims.sub } },
      },
    });
  }

  // 3. Tài khoản đã gắn một tài khoản Google KHÁC (sub khác, cùng email): không liên kết lại. Chống địa chỉ email
  //    Workspace bị tái sử dụng chiếm tài khoản.
  if (await prisma.identity.findFirst({ where: { userId: existing.id, provider: 'GOOGLE' } })) {
    throw new AppError('ACCOUNT_CONFLICT', 'This account is already linked to a different Google account');
  }

  // 4. Email tài khoản đã xác minh: chỉ thêm danh tính, giữ nguyên mật khẩu và phiên.
  if (existing.emailVerifiedAt) {
    await prisma.identity.create({ data: { userId: existing.id, provider: 'GOOGLE', providerAccountId: claims.sub } });
    return fillProfile(existing, claims);
  }

  // 5. Tài khoản mật khẩu CHƯA xác minh: không ai chứng minh được email là của họ, mà Google vừa chứng minh.
  //    Xóa mật khẩu (có thể do kẻ khác đặt trước), thu hồi mọi phiên, vô hiệu các token còn lại rồi gắn Google.
  //    Hệ quả đã biết: người thật đã đăng ký bằng mật khẩu mà chưa bấm link sẽ mất mật khẩu (vẫn vào được bằng Google).
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: existing.id }, data: { passwordHash: null, emailVerifiedAt: now } });
    await tx.session.updateMany({ where: { userId: existing.id, OR: NOT_REVOKED }, data: { revokedAt: now } });
    await tx.verificationToken.updateMany({ where: { userId: existing.id, OR: NOT_USED }, data: { usedAt: now } });
    await tx.identity.create({ data: { userId: existing.id, provider: 'GOOGLE', providerAccountId: claims.sub } });
  });
  return fillProfile({ ...existing, emailVerifiedAt: now }, claims);
}

export async function loginWithGoogle(claims: GoogleClaims, meta: SessionMeta): Promise<{ user: PublicUser; session: IssuedSession }> {
  if (!claims.emailVerified) throw new AppError('PROVIDER_EMAIL_UNVERIFIED', 'Google has not verified this email address');
  const email = claims.email.trim().toLowerCase();

  let user: UserRow | undefined;
  for (let attempt = 0; !user; attempt++) {
    try {
      user = await resolveUser(claims, email);
    } catch (err) {
      if (attempt >= 1 || !isRetryable(err)) throw err; // thử lại đúng một lần
    }
  }
  const session = await createSession(user.id, meta);
  return { user: toPublicUser(user), session };
}
