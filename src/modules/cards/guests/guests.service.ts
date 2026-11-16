import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../infra/prisma';
import { AppError } from '../../../shared/errors';
import { can, roleOf } from '../cards.access';
import { CODE_ALPHABET, CODE_LENGTH, GUEST_LIMITS, parseGuestCode, type GuestEntry, type GuestPatch } from './guests.schema';

// Khách mời của một thiệp: chủ thiệp và người sửa quản lý (cùng quyền với trang Phản hồi); khách chỉ đọc đúng bản ghi của mình bằng mã.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const newCode = (): string => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!).join('');

async function requireGuestsAccess(actor: string, cardId: string): Promise<void> {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { ownerId: true, members: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role) throw new AppError('NOT_FOUND', 'Card not found');
  if (!can(role, 'responses')) throw new AppError('FORBIDDEN', 'You do not have permission to do that');
}

export interface GuestView {
  id: string;
  name: string;
  code: string;
  greeting: string | null;
  inviteMessage: string | null;
  openCount: number;
  firstOpenedAt: Date | null;
  lastOpenedAt: Date | null;
  /** Đã gửi ít nhất một câu trả lời form bằng link của khách này. */
  responded: boolean;
  createdAt: Date;
}

type GuestRow = Prisma.GuestGetPayload<Record<string, never>>;

const viewOf = (row: GuestRow, responded: Set<string>): GuestView => ({
  id: row.id,
  name: row.name,
  code: row.code,
  greeting: row.greeting,
  inviteMessage: row.inviteMessage,
  openCount: row.openCount,
  firstOpenedAt: row.firstOpenedAt,
  lastOpenedAt: row.lastOpenedAt,
  responded: responded.has(row.id),
  createdAt: row.createdAt,
});

async function respondedSet(cardId: string, guestIds: string[]): Promise<Set<string>> {
  if (!guestIds.length) return new Set();
  const rows = await prisma.formResponse.findMany({ where: { cardId, guestId: { in: guestIds } }, select: { guestId: true }, distinct: ['guestId'] });
  return new Set(rows.flatMap((row) => (row.guestId ? [row.guestId] : [])));
}

export async function listGuests(actor: string, cardId: string, search?: string): Promise<GuestView[]> {
  await requireGuestsAccess(actor, cardId);
  const rows = await prisma.guest.findMany({
    where: { cardId, ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const responded = await respondedSet(cardId, rows.map((row) => row.id));
  return rows.map((row) => viewOf(row, responded));
}

// Mã trùng (hiếm: 31^8) thì thử mã khác; chỉ báo lỗi khi cả 5 lần đều trùng.
async function createWithCode(cardId: string, entry: GuestEntry): Promise<GuestRow> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.guest.create({ data: { cardId, code: newCode(), name: entry.name, greeting: entry.greeting ?? null, inviteMessage: entry.inviteMessage ?? null } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
  }
  throw new AppError('INTERNAL', 'Could not allocate a guest code');
}

export async function addGuests(actor: string, cardId: string, entries: GuestEntry[]): Promise<GuestView[]> {
  await requireGuestsAccess(actor, cardId);
  if ((await prisma.guest.count({ where: { cardId } })) + entries.length > GUEST_LIMITS.maxPerCard) {
    throw new AppError('CONFLICT', 'This card cannot take more guests', { reason: 'FULL' });
  }
  const created: GuestRow[] = [];
  for (const entry of entries) created.push(await createWithCode(cardId, entry));
  return created.map((row) => viewOf(row, new Set()));
}

async function guestForActor(actor: string, id: string): Promise<GuestRow> {
  const row = await prisma.guest.findUnique({ where: { id } });
  if (!row) throw new AppError('NOT_FOUND', 'Guest not found');
  await requireGuestsAccess(actor, row.cardId);
  return row;
}

export async function updateGuest(actor: string, id: string, patch: GuestPatch): Promise<GuestView> {
  const row = await guestForActor(actor, id);
  const data: Prisma.GuestUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.greeting !== undefined) data.greeting = patch.greeting;
  if (patch.inviteMessage !== undefined) data.inviteMessage = patch.inviteMessage;
  const updated = await prisma.guest.update({ where: { id }, data });
  return viewOf(updated, await respondedSet(row.cardId, [id]));
}

export async function deleteGuest(actor: string, id: string): Promise<void> {
  await guestForActor(actor, id);
  await prisma.guest.delete({ where: { id } });
}

// --- Phía khách (công khai) ---

async function publishedCardId(slug: string): Promise<string> {
  if (!SLUG.test(slug) || slug.length > 60) throw new AppError('NOT_FOUND', 'Page not found');
  const publication = await prisma.publication.findFirst({
    where: { slug, OR: [{ unpublishedAt: null }, { unpublishedAt: { isSet: false } }] },
    select: { cardId: true },
  });
  if (!publication) throw new AppError('NOT_FOUND', 'Page not found');
  return publication.cardId;
}

export interface PublicGuest {
  name: string;
  greeting: string | null;
  inviteMessage: string | null;
}

// Mã sai, mã của thiệp khác và thiệp chưa xuất bản đều trả NOT_FOUND như nhau: không dò được mã nào tồn tại.
export async function publicGuest(slug: string, rawCode: string): Promise<PublicGuest> {
  const code = parseGuestCode(rawCode);
  const cardId = await publishedCardId(slug);
  const guest = await prisma.guest.findFirst({ where: { code, cardId }, select: { name: true, greeting: true, inviteMessage: true } });
  if (!guest) throw new AppError('NOT_FOUND', 'Guest not found');
  return guest;
}

export async function recordGuestOpen(slug: string, rawCode: string, now: Date = new Date()): Promise<void> {
  const code = parseGuestCode(rawCode);
  const cardId = await publishedCardId(slug);
  const guest = await prisma.guest.findFirst({ where: { code, cardId }, select: { id: true, firstOpenedAt: true } });
  if (!guest) throw new AppError('NOT_FOUND', 'Guest not found');
  await prisma.guest.update({ where: { id: guest.id }, data: { openCount: { increment: 1 }, lastOpenedAt: now, ...(guest.firstOpenedAt ? {} : { firstOpenedAt: now }) } });
}

/** Id khách ứng với mã trong một thiệp, hoặc undefined nếu mã sai (câu trả lời form vẫn nhận, chỉ không gắn khách). */
export async function guestIdFor(cardId: string, rawCode: string | undefined): Promise<string | undefined> {
  if (!rawCode) return undefined;
  let code: string;
  try { code = parseGuestCode(rawCode); } catch { return undefined; }
  const guest = await prisma.guest.findFirst({ where: { code, cardId }, select: { id: true } });
  return guest?.id;
}
