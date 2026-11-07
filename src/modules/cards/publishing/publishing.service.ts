import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../infra/prisma';
import { AppError } from '../../../shared/errors';
import { can, roleOf } from '../cards.access';

export interface PublicationView {
  slug: string;
  publishedAt: Date;
}

// Slug tự đặt từ tiêu đề: bỏ dấu tiếng Việt (đ riêng), chữ thường, mọi ký tự khác thành gạch nối, tối đa 40 ký tự,
// rồi thêm 4 ký tự ngẫu nhiên để hai thiệp cùng tên không đụng nhau.
export function slugFromTitle(title: string): string {
  const base = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const suffix = randomBytes(3).toString('hex').slice(0, 4);
  return base ? `${base}-${suffix}` : `thiep-${suffix}`;
}

const isUniqueViolation = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Chỉ owner xuất bản. Người ngoài nhận NOT_FOUND, người có vai trò nhưng không đủ quyền nhận FORBIDDEN.
async function requireOwner(actor: string, cardId: string) {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { ownerId: true, members: true, title: true, document: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role) throw new AppError('NOT_FOUND', 'Card not found');
  if (!can(role, 'publish')) throw new AppError('FORBIDDEN', 'You do not have permission to do that');
  return card;
}

const hasContent = (document: unknown): boolean =>
  typeof document === 'object' && document !== null && 'root' in document && typeof (document as { root: unknown }).root === 'object';

// Chụp bản nháp hiện tại làm trang công khai. Gọi lại để cập nhật trang; slug cũ được giữ nếu không truyền slug mới.
export async function publishCard(actor: string, cardId: string, requestedSlug?: string): Promise<PublicationView> {
  const card = await requireOwner(actor, cardId);
  if (!hasContent(card.document)) throw new AppError('VALIDATION', 'The card has no content to publish');
  const existing = await prisma.publication.findUnique({ where: { cardId }, select: { slug: true } });
  const now = new Date();
  const snapshot = card.document as Prisma.InputJsonObject;

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = requestedSlug ?? existing?.slug ?? slugFromTitle(card.title);
    try {
      const saved = existing
        ? await prisma.publication.update({ where: { cardId }, data: { slug, document: snapshot, publishedAt: now, unpublishedAt: null } })
        : await prisma.publication.create({ data: { cardId, slug, document: snapshot, publishedAt: now } });
      return { slug: saved.slug, publishedAt: saved.publishedAt };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (requestedSlug) throw new AppError('CONFLICT', 'This link is already taken'); // slug do người dùng chọn
      // slug tự sinh trùng (hiếm): thử lại với slug khác, trừ khi đó là slug cũ của chính thiệp này
      if (existing) throw new AppError('CONFLICT', 'This link is already taken');
    }
  }
  throw new AppError('CONFLICT', 'Could not find a free link, try again');
}

// Gỡ trang công khai. Gọi lại khi đã gỡ vẫn thành công (không đổi gì).
export async function unpublishCard(actor: string, cardId: string): Promise<void> {
  await requireOwner(actor, cardId);
  await prisma.publication.updateMany({
    where: { cardId, OR: [{ unpublishedAt: null }, { unpublishedAt: { isSet: false } }] },
    data: { unpublishedAt: new Date() },
  });
}

// Liên kết đang công khai của thiệp; ai xem được thiệp cũng xem được. null nếu chưa xuất bản hoặc đã gỡ.
export async function getPublication(actor: string, cardId: string): Promise<PublicationView | null> {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { ownerId: true, members: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role || !can(role, 'view')) throw new AppError('NOT_FOUND', 'Card not found');
  const publication = await prisma.publication.findUnique({ where: { cardId }, select: { slug: true, publishedAt: true, unpublishedAt: true } });
  if (!publication || publication.unpublishedAt) return null;
  return { slug: publication.slug, publishedAt: publication.publishedAt };
}
