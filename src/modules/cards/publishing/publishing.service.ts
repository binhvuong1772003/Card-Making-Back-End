import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../infra/prisma';
import { AppError } from '../../../shared/errors';
import { can, roleOf } from '../cards.access';
import { parseCardDocumentForStorage } from '../card-document';
import { galleryStateOf, hideFromGallery, submitToGallery, type GalleryStatus } from '../gallery/gallery.service';

export interface PublicationView {
  id: string;
  slug: string;
  /** Tên bản do chủ thiệp đặt; null nếu chưa đặt. */
  label: string | null;
  /** Bản chính: bản đang mở có id nhỏ nhất. Thư viện công khai chỉ lấy bản này. */
  isMain: boolean;
  publishedAt: Date;
  listInGallery: boolean;
  galleryStatus: GalleryStatus;
  galleryRejectReason: string | null;
}

/** Số bản đang mở tối đa của một thiệp. Bản đã gỡ không tính. */
export const MAX_LIVE_PUBLICATIONS = 5;

const LIVE: Prisma.PublicationWhereInput = { OR: [{ unpublishedAt: null }, { unpublishedAt: { isSet: false } }] };
type PublicationRow = { id: string; slug: string; label: string | null; publishedAt: Date; listInGallery: boolean | null };
const ROW = { id: true, slug: true, label: true, publishedAt: true, listInGallery: true } as const;

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
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { ownerId: true, members: true, title: true, document: true, occasion: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role) throw new AppError('NOT_FOUND', 'Card not found');
  if (!can(role, 'publish')) throw new AppError('FORBIDDEN', 'You do not have permission to do that');
  return card;
}

const NO_GALLERY = { status: 'NONE' as GalleryStatus, rejectReason: null };

// Thư viện công khai chỉ gắn với bản chính; các bản khác luôn không vào thư viện.
const view = (p: PublicationRow, isMain: boolean, gallery: { status: GalleryStatus; rejectReason: string | null }): PublicationView => ({
  id: p.id,
  slug: p.slug,
  label: p.label ?? null,
  isMain,
  publishedAt: p.publishedAt,
  listInGallery: isMain ? (p.listInGallery ?? false) : false,
  galleryStatus: isMain ? gallery.status : NO_GALLERY.status,
  galleryRejectReason: isMain ? gallery.rejectReason : null,
});

// Các bản đang mở của thiệp, bản chính đứng đầu (id tăng theo thời gian tạo).
const liveOf = (cardId: string) => prisma.publication.findMany({ where: { cardId, ...LIVE }, orderBy: { id: 'asc' }, select: ROW });

export interface PublishInput {
  /** Cập nhật bản này (xuất bản lại); bỏ trống là tạo bản mới. */
  publicationId?: string | undefined;
  slug?: string | undefined;
  /** undefined: giữ tên cũ; chuỗi rỗng: bỏ tên. */
  label?: string | undefined;
  listInGallery?: boolean | undefined;
}

// Chụp bản nháp hiện tại làm một bản công khai: cập nhật `publicationId` nếu có, không thì tạo bản mới (tối đa MAX_LIVE_PUBLICATIONS bản đang mở).
// Xuất bản lại giữ slug cũ nếu không truyền slug mới.
export async function publishCard(actor: string, cardId: string, input: PublishInput = {}): Promise<PublicationView> {
  const card = await requireOwner(actor, cardId);
  const page = parseCardDocumentForStorage(card.document); // kiểm tra toàn bộ document trước khi xuất bản
  const lives = await liveOf(cardId);
  const existing = input.publicationId ? await prisma.publication.findFirst({ where: { id: input.publicationId, cardId }, select: ROW }) : null;
  if (input.publicationId && !existing) throw new AppError('NOT_FOUND', 'Publication not found');
  if (!existing && lives.length >= MAX_LIVE_PUBLICATIONS) throw new AppError('CONFLICT', 'This card already has the most versions it can have', { reason: 'LIMIT' });
  const now = new Date();
  const snapshot = page as unknown as Prisma.InputJsonObject;
  const label = input.label === undefined ? undefined : input.label.trim() || null;

  // Bản chính: bản đang mở đầu tiên; bản mới hoặc bản đã gỡ được mở lại thì xếp theo id với các bản đang mở.
  const mainId = [...lives.map((p) => p.id), ...(existing ? [existing.id] : [])].sort()[0];
  const isMain = existing ? existing.id === mainId : lives.length === 0;
  const listInGallery = isMain ? (input.listInGallery ?? false) : false;

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = input.slug ?? existing?.slug ?? slugFromTitle(card.title);
    try {
      const saved = existing
        ? await prisma.publication.update({ where: { id: existing.id }, data: { slug, ...(label !== undefined ? { label } : {}), document: snapshot, publishedAt: now, unpublishedAt: null, listInGallery }, select: ROW })
        : await prisma.publication.create({ data: { cardId, slug, label: label ?? null, document: snapshot, publishedAt: now, listInGallery }, select: ROW });
      // Thư viện công khai: chỉ bản chính. Bật thì gửi bản chụp này vào hàng chờ duyệt, tắt thì rút thiệp khỏi thư viện.
      if (isMain) {
        if (listInGallery) await submitToGallery({ id: cardId, ownerId: card.ownerId, title: card.title, occasion: card.occasion ?? 'OTHER' }, snapshot);
        else await hideFromGallery(cardId);
      }
      return view(saved, isMain, isMain ? await galleryStateOf(cardId) : NO_GALLERY);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (input.slug) throw new AppError('CONFLICT', 'This link is already taken'); // slug do người dùng chọn
      // slug tự sinh trùng (hiếm): thử lại với slug khác, trừ khi đó là slug cũ của chính bản này
      if (existing) throw new AppError('CONFLICT', 'This link is already taken');
    }
  }
  throw new AppError('CONFLICT', 'Could not find a free link, try again');
}

// Gỡ một bản: liên kết đó trả 404, các bản khác không đổi. Gọi lại khi đã gỡ vẫn thành công. Gỡ bản đang nằm trong thư viện thì rút thiệp khỏi thư viện.
export async function unpublishPublication(actor: string, cardId: string, publicationId: string): Promise<void> {
  await requireOwner(actor, cardId);
  const target = await prisma.publication.findFirst({ where: { id: publicationId, cardId }, select: { listInGallery: true } });
  if (!target) throw new AppError('NOT_FOUND', 'Publication not found');
  await prisma.publication.updateMany({ where: { id: publicationId, cardId, ...LIVE }, data: { unpublishedAt: new Date(), listInGallery: false } });
  if (target.listInGallery) await hideFromGallery(cardId);
}

// Gỡ mọi bản của thiệp. Gọi lại khi đã gỡ hết vẫn thành công (không đổi gì).
export async function unpublishCard(actor: string, cardId: string): Promise<void> {
  await requireOwner(actor, cardId);
  await prisma.publication.updateMany({ where: { cardId, ...LIVE }, data: { unpublishedAt: new Date(), listInGallery: false } });
  await hideFromGallery(cardId); // trang đã gỡ thì mẫu cũng rút khỏi thư viện
}

async function requireViewer(actor: string, cardId: string): Promise<void> {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { ownerId: true, members: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role || !can(role, 'view')) throw new AppError('NOT_FOUND', 'Card not found');
}

// Các bản đang công khai của thiệp, bản chính đứng đầu; ai xem được thiệp cũng xem được. Rỗng nếu chưa xuất bản hoặc đã gỡ hết.
export async function getPublications(actor: string, cardId: string): Promise<PublicationView[]> {
  await requireViewer(actor, cardId);
  const lives = await liveOf(cardId);
  if (lives.length === 0) return [];
  const gallery = await galleryStateOf(cardId);
  return lives.map((row, index) => view(row, index === 0, gallery));
}

// Bản chính đang công khai của thiệp; null nếu chưa xuất bản hoặc đã gỡ hết.
export async function getPublication(actor: string, cardId: string): Promise<PublicationView | null> {
  return (await getPublications(actor, cardId))[0] ?? null;
}

// Nạp nội dung đã xuất bản của một bản vào bản nháp để sửa tiếp (chỉ owner). Thay cả bản nháp và tăng `revision`, nên người đang sửa
// cùng sẽ gặp CONFLICT ở lần lưu kế và phải tải lại. Các bản đã xuất bản không đổi. Trả `revision` mới.
export async function restoreDraftFromPublication(actor: string, cardId: string, publicationId: string): Promise<number> {
  await requireOwner(actor, cardId);
  const publication = await prisma.publication.findFirst({ where: { id: publicationId, cardId }, select: { document: true } });
  if (!publication) throw new AppError('NOT_FOUND', 'Publication not found');
  const page = parseCardDocumentForStorage(publication.document) as unknown as Prisma.InputJsonObject;
  const updated = await prisma.card.update({ where: { id: cardId }, data: { document: page, revision: { increment: 1 } }, select: { revision: true } });
  return updated.revision;
}
