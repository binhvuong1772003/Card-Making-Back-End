import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env } from '../../../config/env';
import { prisma } from '../../../infra/prisma';
import { AppError } from '../../../shared/errors';
import { can, roleOf } from '../cards.access';
import { findBlock, FORM_BLOCK } from './responses.config';
import { decodeRowCursor, encodeRowCursor, type EntryStatusValue, type FormInput, type ListEntriesArgs, type ListRsvpsArgs, type RsvpAnswerValue } from './responses.schema';
import { isClosed, parseFormBlock, publicView, validateAnswers, type StoredAnswer } from './form-fields';

// Câu trả lời của khách cho khối `Form` trên trang công khai. Khách ghi không cần đăng nhập; chỉ chủ thiệp và người sửa thiệp
// đọc câu trả lời, còn dòng VISIBLE của form bật sổ công khai thì ai xem thiệp cũng thấy. Cấu hình form lấy từ bản đã xuất bản.
export const LIMITS = {
  maxResponses: 5000, // câu trả lời mỗi thiệp (mọi form cộng lại)
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

function formBlock(document: unknown, blockId: string) {
  const block = findBlock((document as { root?: unknown } | null)?.root, blockId);
  if (!block || block.type !== FORM_BLOCK) throw new AppError('NOT_FOUND', 'Form not found');
  return block;
}

export interface SubmitContext {
  ip: string;
}

// ---- Khách gửi ----

export interface PublicEntry {
  id: string;
  name: string;
  text: string;
  createdAt: Date;
}

export interface SubmitResult {
  id: string;
  status: EntryStatusValue;
  /** Chỉ có khi dòng đang VISIBLE và form bật sổ công khai. */
  entry: PublicEntry | null;
}

// Câu trả lời đã lưu là mảng tự mô tả; đọc lại phòng khi dữ liệu cũ hỏng thay vì làm cả trang lỗi.
const storedAnswers = (value: unknown): StoredAnswer[] => (Array.isArray(value) ? (value as StoredAnswer[]) : []);

function publicEntryOf(row: { id: string; answers: unknown; createdAt: Date }, list: ReturnType<typeof parseFormBlock>['publicList']): PublicEntry | null {
  const view = publicView(storedAnswers(row.answers), list);
  return view ? { id: row.id, name: view.name, text: view.text, createdAt: row.createdAt } : null;
}

// So sánh nội dung đã chuẩn hoá (đúng thứ tự ô, đã bỏ ô lạ/ô ẩn) của lần gửi này với các dòng gần đây.
const sameAnswers = (left: unknown, right: StoredAnswer[]): boolean => JSON.stringify(left) === JSON.stringify(right);

export async function submitForm(slug: string, input: FormInput, context: SubmitContext, deps: Deps = realDeps): Promise<SubmitResult> {
  // Ô ẩn có chữ là máy điền: bỏ qua nhưng vẫn trả như thành công để máy không biết mình bị chặn.
  if (input.website) return { id: 'ignored', status: 'VISIBLE', entry: null };
  const { cardId, document } = await findPublished(slug);
  const config = parseFormBlock(formBlock(document, input.blockId).props);
  const now = deps.now();
  if (isClosed(config.deadline, now)) throw new AppError('CONFLICT', 'This form is closed', { reason: 'CLOSED' });

  const result = validateAnswers(config.fields, input.answers);
  if ('errors' in result) throw new AppError('VALIDATION', 'Invalid answer', result.errors);
  const answers = result.answers;
  // Chỉ form bật sổ công khai mới có trạng thái chờ duyệt; form khác luôn VISIBLE (không ai xem công khai nên không cần duyệt).
  const status: EntryStatusValue = config.publicList.enabled && config.moderation ? 'PENDING' : 'VISIBLE';

  const ipHash = ipHashOf(context.ip, now);
  const recent = await prisma.formResponse.findMany({
    where: { cardId, blockId: input.blockId, ipHash, createdAt: { gte: new Date(now.getTime() - deps.limits.duplicateWindowMs) } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const same = recent.find((row) => sameAnswers(row.answers, answers));
  if (same) return { id: same.id, status: same.status, entry: same.status === 'VISIBLE' ? publicEntryOf(same, config.publicList) : null };

  if ((await prisma.formResponse.count({ where: { cardId } })) >= deps.limits.maxResponses) {
    throw new AppError('CONFLICT', 'This card cannot take more responses', { reason: 'FULL' });
  }
  const row = await prisma.formResponse.create({
    data: { cardId, blockId: input.blockId, answers: answers as unknown as Prisma.InputJsonValue, status, ipHash, createdAt: now },
    select: { id: true, answers: true, createdAt: true },
  });
  return { id: row.id, status, entry: status === 'VISIBLE' ? publicEntryOf(row, config.publicList) : null };
}

export interface PublicEntryPage {
  entries: PublicEntry[];
  nextCursor: string | null;
  total: number;
}

// Sổ công khai của một form: chỉ dòng VISIBLE, mới nhất trước, chỉ tên và lời. Form không bật sổ thì coi như không có.
export async function listPublicEntries(slug: string, blockId: string, args: { first: number; after?: string | undefined }): Promise<PublicEntryPage> {
  const { cardId, document } = await findPublished(slug);
  const config = parseFormBlock(formBlock(document, blockId).props);
  if (!config.publicList.enabled) throw new AppError('NOT_FOUND', 'Form not found');
  const cursor = args.after ? decodeRowCursor(args.after) : undefined;
  const base = { cardId, blockId, status: 'VISIBLE' as const };
  const [rows, total] = await Promise.all([
    prisma.formResponse.findMany({
      where: cursor ? { ...base, OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : base,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: args.first + 1,
      select: { id: true, answers: true, createdAt: true },
    }),
    prisma.formResponse.count({ where: base }),
  ]);
  const page = rows.slice(0, args.first);
  // Dòng cũ có thể thiếu ô tên/lời sau khi chủ thiệp đổi ô: bỏ khỏi sổ chứ không hiện dòng trống.
  const entries = page.flatMap((row) => {
    const entry = publicEntryOf(row, config.publicList);
    return entry ? [entry] : [];
  });
  const last = page.at(-1);
  return { entries, nextCursor: rows.length > args.first && last ? encodeRowCursor(last) : null, total };
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
