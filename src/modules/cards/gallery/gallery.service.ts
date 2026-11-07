import { Prisma, type Template } from '@prisma/client';
import { env } from '../../../config/env';
import { copyImage, type CloudinaryConfig } from '../../../infra/cloudinary';
import { prisma } from '../../../infra/prisma';
import { AppError } from '../../../shared/errors';
import { createCardFromSnapshot, type CardView } from '../cards.service';
import { decodeCursor, encodeCursor, type CardOccasion } from '../cards.schema';
import type { ListTemplatesArgs, TemplateStatus } from './gallery.schema';
import { collectImageUrls, replaceImageUrls } from './template-images';

export interface TemplateView {
  id: string;
  title: string;
  category: CardOccasion;
  authorName: string;
  authorEmail: string | null;
  useCount: number;
  status: TemplateStatus;
  rejectReason: string | null;
  publishedAt: Date | null;
  snapshot: unknown;
}

export interface TemplatePage {
  nodes: TemplateView[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export type GalleryStatus = 'NONE' | 'PENDING' | 'REJECTED' | 'LIVE';

const ANONYMOUS_AUTHOR = 'Người dùng CardMaking';
const CATEGORIES: readonly CardOccasion[] = ['WEDDING', 'BIRTHDAY', 'EVENT', 'OTHER'];
const WITH_AUTHOR = { author: { select: { name: true, email: true } } } as const;

type TemplateRow = Template & { author: { name: string | null; email: string } | null };

const asCategory = (value: string): CardOccasion => (CATEGORIES as readonly string[]).includes(value) ? (value as CardOccasion) : 'OTHER';

// Email của tác giả chỉ đi ra cho admin; người dùng thường chỉ thấy tên hiển thị (hoặc tên trung tính).
function toView(row: TemplateRow, forAdmin: boolean): TemplateView {
  return {
    id: row.id,
    title: row.title,
    category: asCategory(row.category),
    authorName: row.author?.name?.trim() || ANONYMOUS_AUTHOR,
    authorEmail: forAdmin ? (row.author?.email ?? null) : null,
    useCount: row.useCount,
    status: row.status,
    rejectReason: row.rejectReason ?? null,
    publishedAt: row.publishedAt ?? null,
    snapshot: row.snapshot,
  };
}

// ---- Phía chủ thiệp (gọi từ publishing) ----

// Gửi bản chụp vào hàng chờ duyệt. Đã có bản chờ hoặc bị từ chối của thiệp này thì thay bằng bản mới và quay lại chờ duyệt;
// bản đang hiện (nếu có) giữ nguyên cho tới khi bản mới được duyệt.
export async function submitToGallery(card: { id: string; ownerId: string; title: string; occasion: CardOccasion }, snapshot: Prisma.InputJsonObject): Promise<void> {
  const data = { title: card.title, category: card.occasion, snapshot, authorId: card.ownerId, status: 'PENDING' as const, rejectReason: null, reviewedAt: null, reviewedById: null };
  const open = await prisma.template.findFirst({ where: { sourceCardId: card.id, status: { in: ['PENDING', 'REJECTED'] } }, select: { id: true } });
  if (open) await prisma.template.update({ where: { id: open.id }, data });
  else await prisma.template.create({ data: { ...data, sourceCardId: card.id, tags: [], version: 1 } });
}

// Rút thiệp khỏi thư viện: bản đang hiện thành UNLISTED (ẩn, giữ lại), bản chờ và bản bị từ chối bị xoá.
export async function hideFromGallery(cardId: string): Promise<void> {
  await prisma.template.updateMany({ where: { sourceCardId: cardId, status: 'PUBLISHED' }, data: { status: 'UNLISTED' } });
  await prisma.template.deleteMany({ where: { sourceCardId: cardId, status: { in: ['PENDING', 'REJECTED'] } } });
}

// Trạng thái thư viện của thiệp, nhìn từ chủ thiệp. Ưu tiên: đang chờ, bị từ chối, đang hiện, không có.
export async function galleryStateOf(cardId: string): Promise<{ status: GalleryStatus; rejectReason: string | null }> {
  const rows = await prisma.template.findMany({ where: { sourceCardId: cardId, status: { in: ['PENDING', 'REJECTED', 'PUBLISHED'] } }, select: { status: true, rejectReason: true } });
  if (rows.some((r) => r.status === 'PENDING')) return { status: 'PENDING', rejectReason: null };
  const rejected = rows.find((r) => r.status === 'REJECTED');
  if (rejected) return { status: 'REJECTED', rejectReason: rejected.rejectReason ?? null };
  if (rows.some((r) => r.status === 'PUBLISHED')) return { status: 'LIVE', rejectReason: null };
  return { status: 'NONE', rejectReason: null };
}

// ---- Phía người xem thư viện ----

type Cursor = { updatedAt: Date; id: string };

async function page(where: Prisma.TemplateWhereInput, first: number, after: string | undefined, forAdmin: boolean, order: 'publishedAt' | 'createdAt'): Promise<TemplatePage> {
  const cursor: Cursor | undefined = after ? decodeCursor(after) : undefined;
  const rows = await prisma.template.findMany({
    where: {
      AND: [where, ...(cursor ? [{ OR: [{ [order]: { lt: cursor.updatedAt } }, { [order]: cursor.updatedAt, id: { lt: cursor.id } }] }] : [])],
    },
    orderBy: [{ [order]: 'desc' }, { id: 'desc' }],
    take: first + 1,
    include: WITH_AUTHOR,
  });
  const slice = rows.slice(0, first);
  const last = slice[slice.length - 1];
  return {
    nodes: slice.map((row) => toView(row, forAdmin)),
    pageInfo: { hasNextPage: rows.length > first, endCursor: last ? encodeCursor({ updatedAt: (last[order] ?? last.createdAt) as Date, id: last.id }) : null },
  };
}

export const listTemplates = (_actor: string, args: ListTemplatesArgs): Promise<TemplatePage> =>
  page({ status: 'PUBLISHED', ...(args.category ? { category: args.category } : {}) }, args.first, args.after, false, 'publishedAt');

export async function getTemplate(_actor: string, id: string): Promise<TemplateView> {
  const row = await prisma.template.findFirst({ where: { id, status: 'PUBLISHED' }, include: WITH_AUTHOR });
  if (!row) throw new AppError('NOT_FOUND', 'Template not found');
  return toView(row, false);
}

export async function templateCounts(): Promise<{ category: CardOccasion; count: number }[]> {
  return Promise.all(CATEGORIES.map(async (category) => ({ category, count: await prisma.template.count({ where: { status: 'PUBLISHED', category } }) })));
}

const isObjectId = (value: string): boolean => /^[0-9a-f]{24}$/i.test(value);

// Dùng mẫu: thiệp mới của người gọi từ bản chụp. Chỉ mẫu đang hiện; id sai dạng hay mẫu không hiện đều NOT_FOUND.
export async function useTemplate(actor: string, id: string): Promise<CardView> {
  if (!isObjectId(id)) throw new AppError('NOT_FOUND', 'Template not found');
  const template = await prisma.template.findFirst({ where: { id, status: 'PUBLISHED' } });
  if (!template) throw new AppError('NOT_FOUND', 'Template not found');
  const card = await createCardFromSnapshot(actor, { title: template.title, occasion: asCategory(template.category), document: template.snapshot, sourceTemplateId: template.id });
  await prisma.template.update({ where: { id: template.id }, data: { useCount: { increment: 1 } } });
  return card;
}

// ---- Phía admin ----

async function requireAdmin(actor: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: actor }, select: { role: true } });
  if (user?.role !== 'ADMIN') throw new AppError('FORBIDDEN', 'You do not have permission to do that');
}

export async function adminListTemplates(actor: string, args: { status: TemplateStatus; first: number; after?: string }): Promise<TemplatePage> {
  await requireAdmin(actor);
  return page({ status: args.status }, args.first, args.after, true, 'createdAt');
}

async function requirePending(id: string): Promise<TemplateRow> {
  if (!isObjectId(id)) throw new AppError('NOT_FOUND', 'Template not found');
  const row = await prisma.template.findUnique({ where: { id }, include: WITH_AUTHOR });
  if (!row) throw new AppError('NOT_FOUND', 'Template not found');
  if (row.status !== 'PENDING') throw new AppError('CONFLICT', 'This template is not waiting for review');
  return row;
}

export interface ApproveDeps {
  cloudinary: CloudinaryConfig | null;
  copy: typeof copyImage;
}
const defaultDeps = (): ApproveDeps => ({ cloudinary: env.cloudinary, copy: copyImage });

// Duyệt: sao chép ảnh của mình vào thư mục chung của mẫu (nơi ảnh sống lâu hơn thiệp của tác giả), viết lại địa chỉ trong bản chụp,
// rồi cho hiện. Thiệp này đã có mẫu đang hiện (hoặc đã ẩn) thì bản chờ thay mẫu đó tại chỗ (giữ id, số lần dùng) và bị xoá.
// Sao chép lỗi thì không đổi gì (làm lại được: cùng ảnh cho cùng địa chỉ).
export async function approveTemplate(actor: string, id: string, deps: ApproveDeps = defaultDeps()): Promise<TemplateView> {
  await requireAdmin(actor);
  const pending = await requirePending(id);
  const target = pending.sourceCardId
    ? await prisma.template.findFirst({ where: { sourceCardId: pending.sourceCardId, status: { in: ['PUBLISHED', 'UNLISTED'] }, id: { not: pending.id } } })
    : null;
  const targetId = target?.id ?? pending.id;

  let snapshot = pending.snapshot;
  if (deps.cloudinary) {
    const urls = collectImageUrls(snapshot, deps.cloudinary.cloudName);
    if (urls.length > 0) {
      const config = deps.cloudinary;
      const copies = await Promise.all(urls.map(async (url) => [url, await deps.copy(url, `cardmaking/templates/${targetId}`, config)] as const));
      snapshot = replaceImageUrls(snapshot, new Map(copies)) as Prisma.JsonValue;
    }
  } else if (typeof snapshot === 'object' && snapshot !== null && JSON.stringify(snapshot).includes('res.cloudinary.com')) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Image storage is not configured, so the pictures cannot be copied');
  }

  const now = new Date();
  const live = { title: pending.title, category: pending.category, snapshot: snapshot as Prisma.InputJsonValue, status: 'PUBLISHED' as const, publishedAt: now, rejectReason: null, reviewedAt: now, reviewedById: actor };
  const saved = await prisma.$transaction(async (tx) => {
    const moved = await tx.template.updateMany({ where: { id: pending.id, status: 'PENDING' }, data: target ? { status: 'REMOVED' } : live });
    if (moved.count === 0) throw new AppError('CONFLICT', 'This template is not waiting for review'); // hai admin duyệt cùng lúc
    if (!target) return tx.template.findUniqueOrThrow({ where: { id: pending.id }, include: WITH_AUTHOR });
    const updated = await tx.template.update({ where: { id: target.id }, data: { ...live, version: { increment: 1 } }, include: WITH_AUTHOR });
    await tx.template.delete({ where: { id: pending.id } });
    return updated;
  });
  return toView(saved, true);
}

export async function rejectTemplate(actor: string, id: string, reason: string): Promise<TemplateView> {
  await requireAdmin(actor);
  const pending = await requirePending(id);
  const now = new Date();
  const moved = await prisma.template.updateMany({ where: { id: pending.id, status: 'PENDING' }, data: { status: 'REJECTED', rejectReason: reason, reviewedAt: now, reviewedById: actor } });
  if (moved.count === 0) throw new AppError('CONFLICT', 'This template is not waiting for review');
  return toView(await prisma.template.findUniqueOrThrow({ where: { id }, include: WITH_AUTHOR }), true);
}

// Gỡ mẫu đang hiện khỏi thư viện. Thiệp đã tạo từ mẫu không bị ảnh hưởng (chúng là bản sao độc lập).
export async function removeTemplate(actor: string, id: string): Promise<TemplateView> {
  await requireAdmin(actor);
  if (!isObjectId(id)) throw new AppError('NOT_FOUND', 'Template not found');
  const row = await prisma.template.findUnique({ where: { id }, select: { status: true } });
  if (!row) throw new AppError('NOT_FOUND', 'Template not found');
  const moved = await prisma.template.updateMany({ where: { id, status: 'PUBLISHED' }, data: { status: 'REMOVED' } });
  if (moved.count === 0) throw new AppError('CONFLICT', 'Only a live template can be removed');
  return toView(await prisma.template.findUniqueOrThrow({ where: { id }, include: WITH_AUTHOR }), true);
}
