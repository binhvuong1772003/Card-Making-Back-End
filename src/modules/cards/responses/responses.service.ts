import { createHmac } from 'node:crypto';
import { env } from '../../../config/env';
import { prisma } from '../../../infra/prisma';
import { AppError } from '../../../shared/errors';
import { can, roleOf } from '../cards.access';
import { findBlock, GUESTBOOK_BLOCK, guestbookConfig, isClosed, RSVP_BLOCK, rsvpConfig } from './responses.config';
import { decodeRowCursor, encodeRowCursor, type EntryStatusValue, type GuestbookInput, type ListEntriesArgs, type ListRsvpsArgs, type RsvpAnswerValue, type RsvpInput } from './responses.schema';

// Xác nhận tham dự và sổ lưu bút do khách gửi qua form trên trang công khai. Khách ghi không cần đăng nhập; chỉ chủ thiệp và người sửa thiệp
// đọc xác nhận, còn lời chúc VISIBLE thì ai xem thiệp cũng thấy. Cấu hình form lấy từ bản đã xuất bản của thiệp, không từ khách.
export const LIMITS = {
  maxRsvps: 2000, // dòng xác nhận mỗi thiệp
  maxEntries: 5000, // lời chúc mỗi thiệp
  duplicateWindowMs: 60_000, // gửi lặp y hệt trong khoảng này coi là một
};

export interface Deps {
  now: () => Date;
  limits: typeof LIMITS;
}
const realDeps: Deps = { now: () => new Date(), limits: LIMITS };

// HMAC của IP và ngày: giới hạn và gỡ thư rác được mà không giữ IP thô; sang ngày khác thì băm khác.
export function ipHashOf(ip: string, now: Date): string {
  return createHmac('sha256', env.JWT_SECRET).update(`responses:${now.toISOString().slice(0, 10)}:${ip}`).digest('hex').slice(0, 32);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Thiệp đang công khai theo slug; sai dạng, không có, hoặc đã gỡ đều là NOT_FOUND cùng một thông điệp.
async function findPublished(slug: string): Promise<{ cardId: string; document: unknown }> {
  if (!SLUG.test(slug) || slug.length > 60) throw new AppError('NOT_FOUND', 'Page not found');
  const publication = await prisma.publication.findFirst({
    where: { slug, OR: [{ unpublishedAt: null }, { unpublishedAt: { isSet: false } }] },
    select: { cardId: true, document: true },
  });
  if (!publication) throw new AppError('NOT_FOUND', 'Page not found');
  return publication;
}

function formBlock(document: unknown, blockId: string, type: string) {
  const block = findBlock((document as { root?: unknown } | null)?.root, blockId);
  if (!block || block.type !== type) throw new AppError('NOT_FOUND', 'Form not found');
  return block;
}

export interface SubmitContext {
  ip: string;
}

// ---- Khách gửi ----

export async function submitRsvp(slug: string, input: RsvpInput, context: SubmitContext, deps: Deps = realDeps): Promise<{ id: string }> {
  // Ô ẩn có chữ là máy điền: bỏ qua nhưng vẫn trả như thành công để máy không biết mình bị chặn.
  if (input.website) return { id: 'ignored' };
  const { cardId, document } = await findPublished(slug);
  const config = rsvpConfig(formBlock(document, input.blockId, RSVP_BLOCK).props);
  const now = deps.now();
  if (isClosed(config.deadline, now)) throw new AppError('CONFLICT', 'This form is closed', { reason: 'CLOSED' });
  if (input.attending === 'MAYBE' && !config.askMaybe) throw new AppError('VALIDATION', 'Invalid answer');

  // NO không có số khách. Còn lại: không hỏi số khách thì là 1; hỏi thì mặc định 1 và không vượt tối đa của khối.
  let guests: number | undefined;
  if (input.attending !== 'NO') {
    guests = config.askGuests ? (input.guests ?? 1) : 1;
    if (guests > config.maxGuests) throw new AppError('VALIDATION', `At most ${config.maxGuests} guests`);
  }
  const phone = config.askPhone ? input.phone : undefined;
  const note = config.askNote ? input.note : undefined;

  const ipHash = ipHashOf(context.ip, now);
  const recent = await prisma.rsvp.findMany({
    where: { cardId, blockId: input.blockId, ipHash, createdAt: { gte: new Date(now.getTime() - deps.limits.duplicateWindowMs) } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const same = recent.find((row) => row.name === input.name && row.attending === input.attending && (row.guests ?? undefined) === guests && (row.phone ?? undefined) === phone && (row.note ?? undefined) === note);
  if (same) return { id: same.id };

  if ((await prisma.rsvp.count({ where: { cardId } })) >= deps.limits.maxRsvps) throw new AppError('CONFLICT', 'This card cannot take more responses', { reason: 'FULL' });
  const row = await prisma.rsvp.create({
    data: { cardId, blockId: input.blockId, name: input.name, attending: input.attending, ...(guests !== undefined ? { guests } : {}), ...(phone ? { phone } : {}), ...(note ? { note } : {}), ipHash, createdAt: now },
    select: { id: true },
  });
  return { id: row.id };
}

export interface PublicEntry {
  id: string;
  name: string;
  message: string;
  createdAt: Date;
}

export async function submitGuestbook(slug: string, input: GuestbookInput, context: SubmitContext, deps: Deps = realDeps): Promise<{ id: string; status: EntryStatusValue; entry: PublicEntry | null }> {
  if (input.website) return { id: 'ignored', status: 'VISIBLE', entry: null };
  const { cardId, document } = await findPublished(slug);
  const config = guestbookConfig(formBlock(document, input.blockId, GUESTBOOK_BLOCK).props);
  const now = deps.now();
  const status: EntryStatusValue = config.moderation ? 'PENDING' : 'VISIBLE';
  const view = (row: { id: string; name: string; message: string; createdAt: Date }): PublicEntry | null => (status === 'VISIBLE' ? { id: row.id, name: row.name, message: row.message, createdAt: row.createdAt } : null);

  const ipHash = ipHashOf(context.ip, now);
  const same = await prisma.guestbookEntry.findFirst({
    where: { cardId, blockId: input.blockId, ipHash, name: input.name, message: input.message, createdAt: { gte: new Date(now.getTime() - deps.limits.duplicateWindowMs) } },
  });
  if (same) return { id: same.id, status: same.status, entry: same.status === 'VISIBLE' ? { id: same.id, name: same.name, message: same.message, createdAt: same.createdAt } : null };

  if ((await prisma.guestbookEntry.count({ where: { cardId } })) >= deps.limits.maxEntries) throw new AppError('CONFLICT', 'This card cannot take more responses', { reason: 'FULL' });
  const row = await prisma.guestbookEntry.create({ data: { cardId, blockId: input.blockId, name: input.name, message: input.message, status, ipHash, createdAt: now } });
  return { id: row.id, status, entry: view(row) };
}

export interface PublicEntryPage {
  entries: PublicEntry[];
  nextCursor: string | null;
  total: number;
}

// Lời chúc đang hiện của một sổ lưu bút, mới nhất trước. Chỉ tên, lời và thời gian: không có trạng thái, mã IP hay mã thiệp.
export async function listGuestbook(slug: string, blockId: string, args: { first: number; after?: string | undefined }): Promise<PublicEntryPage> {
  const { cardId, document } = await findPublished(slug);
  formBlock(document, blockId, GUESTBOOK_BLOCK);
  const cursor = args.after ? decodeRowCursor(args.after) : undefined;
  const base = { cardId, blockId, status: 'VISIBLE' as const };
  const [rows, total] = await Promise.all([
    prisma.guestbookEntry.findMany({
      where: cursor ? { ...base, OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : base,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: args.first + 1,
      select: { id: true, name: true, message: true, createdAt: true },
    }),
    prisma.guestbookEntry.count({ where: base }),
  ]);
  const page = rows.slice(0, args.first);
  const last = page.at(-1);
  return { entries: page, nextCursor: rows.length > args.first && last ? encodeRowCursor(last) : null, total };
}

// ---- Chủ thiệp và người sửa thiệp ----

// Người ngoài thiệp và id sai dạng nhận NOT_FOUND cùng một thông điệp; có vai trò nhưng không đủ quyền (người xem) nhận FORBIDDEN.
async function requireResponsesAccess(actor: string, cardId: string): Promise<void> {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { ownerId: true, members: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role) throw new AppError('NOT_FOUND', 'Card not found');
  if (!can(role, 'responses')) throw new AppError('FORBIDDEN', 'You do not have permission to do that');
}

export interface RsvpView {
  id: string;
  blockId: string;
  name: string;
  attending: RsvpAnswerValue;
  guests: number | null;
  phone: string | null;
  note: string | null;
  createdAt: Date;
}

const rsvpView = (row: { id: string; blockId: string; name: string; attending: RsvpAnswerValue; guests: number | null; phone: string | null; note: string | null; createdAt: Date }): RsvpView => ({
  id: row.id,
  blockId: row.blockId,
  name: row.name,
  attending: row.attending,
  guests: row.guests ?? null,
  phone: row.phone ?? null,
  note: row.note ?? null,
  createdAt: row.createdAt,
});

export interface RsvpSummary {
  yes: number;
  no: number;
  maybe: number;
  /** Tổng số khách của các xác nhận Có. */
  guests: number;
}

export interface RsvpPage {
  nodes: RsvpView[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  summary: RsvpSummary;
}

const newestFirst = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

// Danh sách xác nhận của một thiệp, mới nhất trước, kèm tổng theo đáp án (tính trên mọi xác nhận của thiệp, không theo bộ lọc đáp án hay tìm kiếm).
// Mỗi thiệp có tối đa LIMITS.maxRsvps dòng nên lọc theo tên và chia trang ngay trong bộ nhớ: tránh bộ lọc `contains` của Prisma trên Mongo, vốn
// hiểu ký tự đặc biệt của chuỗi tìm kiếm như biểu thức chính quy.
export async function listRsvps(actor: string, cardId: string, args: ListRsvpsArgs): Promise<RsvpPage> {
  await requireResponsesAccess(actor, cardId);
  const all = (await prisma.rsvp.findMany({ where: { cardId, ...(args.blockId ? { blockId: args.blockId } : {}) }, select: { id: true, blockId: true, name: true, attending: true, guests: true, phone: true, note: true, createdAt: true } })).sort(newestFirst);
  const summary: RsvpSummary = { yes: 0, no: 0, maybe: 0, guests: 0 };
  for (const row of all) {
    if (row.attending === 'YES') {
      summary.yes += 1;
      summary.guests += row.guests ?? 1;
    } else if (row.attending === 'NO') summary.no += 1;
    else summary.maybe += 1;
  }
  const needle = args.search?.toLowerCase();
  let rows = all.filter((row) => (!args.answer || row.attending === args.answer) && (!needle || row.name.toLowerCase().includes(needle)));
  if (args.after) {
    const cursor = decodeRowCursor(args.after);
    rows = rows.filter((row) => row.createdAt.getTime() < cursor.createdAt.getTime() || (row.createdAt.getTime() === cursor.createdAt.getTime() && row.id < cursor.id));
  }
  const page = rows.slice(0, args.first);
  const last = page.at(-1);
  return { nodes: page.map(rsvpView), pageInfo: { hasNextPage: rows.length > args.first, endCursor: last ? encodeRowCursor(last) : null }, summary };
}

export interface EntryView {
  id: string;
  blockId: string;
  name: string;
  message: string;
  status: EntryStatusValue;
  createdAt: Date;
}

export interface EntryPage {
  nodes: EntryView[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  counts: { visible: number; hidden: number; pending: number };
}

export async function listEntries(actor: string, cardId: string, args: ListEntriesArgs): Promise<EntryPage> {
  await requireResponsesAccess(actor, cardId);
  const block = args.blockId ? { blockId: args.blockId } : {};
  const cursor = args.after ? decodeRowCursor(args.after) : undefined;
  const where = { cardId, ...block, ...(args.status ? { status: args.status } : {}) };
  const [rows, visible, hidden, pending] = await Promise.all([
    prisma.guestbookEntry.findMany({
      where: cursor ? { ...where, OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: args.first + 1,
      select: { id: true, blockId: true, name: true, message: true, status: true, createdAt: true },
    }),
    prisma.guestbookEntry.count({ where: { cardId, ...block, status: 'VISIBLE' } }),
    prisma.guestbookEntry.count({ where: { cardId, ...block, status: 'HIDDEN' } }),
    prisma.guestbookEntry.count({ where: { cardId, ...block, status: 'PENDING' } }),
  ]);
  const page = rows.slice(0, args.first);
  const last = page.at(-1);
  return { nodes: page, pageInfo: { hasNextPage: rows.length > args.first, endCursor: last ? encodeRowCursor(last) : null }, counts: { visible, hidden, pending } };
}

export async function deleteRsvp(actor: string, id: string): Promise<void> {
  const row = await prisma.rsvp.findUnique({ where: { id }, select: { cardId: true } });
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  await requireResponsesAccess(actor, row.cardId);
  await prisma.rsvp.deleteMany({ where: { id } });
}

export async function deleteEntry(actor: string, id: string): Promise<void> {
  const row = await prisma.guestbookEntry.findUnique({ where: { id }, select: { cardId: true } });
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  await requireResponsesAccess(actor, row.cardId);
  await prisma.guestbookEntry.deleteMany({ where: { id } });
}

export async function setEntryStatus(actor: string, id: string, status: EntryStatusValue): Promise<EntryView> {
  const row = await prisma.guestbookEntry.findUnique({ where: { id }, select: { cardId: true } });
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  await requireResponsesAccess(actor, row.cardId);
  return prisma.guestbookEntry.update({ where: { id }, data: { status }, select: { id: true, blockId: true, name: true, message: true, status: true, createdAt: true } });
}

// ---- CSV ----

const ANSWER_TEXT: Record<RsvpAnswerValue, string> = { YES: 'Có', NO: 'Không đến', MAYBE: 'Chưa chắc' };
const VN_TIME = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// Ô đầu bằng = + - @ hoặc ký tự điều khiển bị bảng tính hiểu là công thức (khách gõ được vào tên và lời nhắn): chèn dấu nháy đơn phía trước.
const cell = (value: string | number | null | undefined): string => {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function buildRsvpsCsv(rows: RsvpView[]): string {
  const header = ['Họ và tên', 'Đáp án', 'Số khách', 'Số điện thoại', 'Lời nhắn', 'Gửi lúc'];
  const lines = rows.map((row) => [row.name, ANSWER_TEXT[row.attending], row.guests, row.phone, row.note, VN_TIME.format(row.createdAt)].map(cell).join(','));
  // BOM để Excel mở tệp UTF-8 đúng tiếng Việt; xuống dòng CRLF theo chuẩn CSV.
  return `﻿${[header.map(cell).join(','), ...lines].join('\r\n')}\r\n`;
}

export async function exportRsvpsCsv(actor: string, cardId: string): Promise<string> {
  await requireResponsesAccess(actor, cardId);
  const rows = await prisma.rsvp.findMany({ where: { cardId }, select: { id: true, blockId: true, name: true, attending: true, guests: true, phone: true, note: true, createdAt: true } });
  // Cũ trước, mới sau: đọc như một danh sách theo thời gian.
  return buildRsvpsCsv(rows.sort((a, b) => -newestFirst(a, b)).map(rsvpView));
}
