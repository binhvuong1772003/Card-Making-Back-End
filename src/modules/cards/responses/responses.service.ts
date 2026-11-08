import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env } from '../../../config/env';
import { prisma } from '../../../infra/prisma';
import { AppError } from '../../../shared/errors';
import { can, roleOf } from '../cards.access';
import { collectFormBlocks, findBlock, FORM_BLOCK } from './responses.config';
import { decodeRowCursor, encodeRowCursor, type EntryStatusValue, type FormInput, type FormResponsesArgs } from './responses.schema';
import { isClosed, parseFormBlock, publicView, validateAnswers, type Field, type FieldType, type StoredAnswer } from './form-fields';

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

const publishedRoot = async (cardId: string): Promise<unknown> => {
  const publication = await prisma.publication.findUnique({ where: { cardId }, select: { document: true } });
  return (publication?.document as { root?: unknown } | undefined)?.root;
};

export interface FormFieldInfo {
  id: string;
  label: string;
  type: FieldType;
  options: string[];
}

export interface CardFormView {
  blockId: string;
  heading: string;
  fields: FormFieldInfo[];
  publicList: boolean;
  moderation: boolean;
  /** Khối không còn trong bản xuất bản nhưng vẫn còn câu trả lời. */
  removed: boolean;
  total: number;
  pending: number;
}

interface Counts {
  total: number;
  pending: number;
}

const fieldInfo = (field: Field): FormFieldInfo => ({ id: field.id, label: field.label, type: field.type, options: field.options ?? [] });

// Tất cả khối `Form` của thiệp, theo thứ tự trong bản xuất bản; khối đã bị gỡ nhưng còn câu trả lời xếp sau, nhờ vậy chủ thiệp
// không mất dữ liệu cũ khi sửa thiệp.
export async function listCardForms(actor: string, cardId: string): Promise<CardFormView[]> {
  await requireResponsesAccess(actor, cardId);
  const blocks = collectFormBlocks(await publishedRoot(cardId));
  const rows = await prisma.formResponse.findMany({ where: { cardId }, select: { blockId: true, status: true } });
  const counts = new Map<string, Counts>();
  for (const row of rows) {
    const current = counts.get(row.blockId) ?? { total: 0, pending: 0 };
    current.total += 1;
    if (row.status === 'PENDING') current.pending += 1;
    counts.set(row.blockId, current);
  }

  const forms: CardFormView[] = blocks.map((block) => {
    const config = parseFormBlock(block.props);
    const count = counts.get(block.id) ?? { total: 0, pending: 0 };
    return {
      blockId: block.id,
      heading: typeof block.props.heading === 'string' ? block.props.heading : '',
      fields: config.fields.map(fieldInfo),
      publicList: config.publicList.enabled,
      moderation: config.moderation,
      removed: false,
      ...count,
    };
  });
  const known = new Set(forms.map((form) => form.blockId));
  for (const [blockId, count] of counts) {
    if (known.has(blockId)) continue;
    forms.push({ blockId, heading: '', fields: [], publicList: false, moderation: false, removed: true, ...count });
  }
  return forms;
}

export interface FormSummaryView {
  fieldId: string;
  label: string;
  type: FieldType;
  answered: number;
  counts: { option: string; count: number }[];
  /** Tổng giá trị của ô `number`; null với loại khác. */
  total: number | null;
}

export interface FormResponsesPage {
  nodes: { id: string; blockId: string; answers: StoredAnswer[]; status: EntryStatusValue; createdAt: Date }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  summary: FormSummaryView[];
  counts: { visible: number; hidden: number; pending: number };
}

const newestFirst = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

// Ô của khối đã bị gỡ: lấy lại từ chính câu trả lời đã lưu, đủ để hiện nhãn và đếm.
function fieldsFromAnswers(answers: StoredAnswer[]): Field[] {
  const seen = new Map<string, Field>();
  for (const answer of answers) {
    if (seen.has(answer.id)) continue;
    const options = answer.type === 'choice' || answer.type === 'multichoice' ? [...new Set(answers.filter((item) => item.id === answer.id).flatMap((item) => (Array.isArray(item.value) ? item.value : [item.value])))].filter((item): item is string => typeof item === 'string') : undefined;
    seen.set(answer.id, { id: answer.id, label: answer.label, type: answer.type, required: false, ...(options && options.length >= 2 ? { options } : {}) });
  }
  return [...seen.values()];
}

// Tóm tắt tính trên MỌI dòng của khối (không theo bộ lọc trạng thái hay tìm kiếm), ở JS: trần dòng của thiệp đủ nhỏ.
function summarize(fields: Field[], rows: { answers: unknown }[]): FormSummaryView[] {
  return fields.map((field) => {
    const values = rows.flatMap((row) => storedAnswers(row.answers).filter((answer) => answer.id === field.id).map((answer) => answer.value));
    const summary: FormSummaryView = { fieldId: field.id, label: field.label, type: field.type, answered: values.length, counts: [], total: null };
    if (field.type === 'number') {
      summary.total = values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
    } else if (field.type === 'yesno') {
      summary.counts = [
        { option: 'Có', count: values.filter((value) => value === true).length },
        { option: 'Không', count: values.filter((value) => value === false).length },
      ];
    } else if (field.type === 'choice' || field.type === 'multichoice') {
      summary.counts = (field.options ?? []).map((option) => ({
        option,
        count: values.filter((value) => (Array.isArray(value) ? value.includes(option) : value === option)).length,
      }));
    }
    return summary;
  });
}

const stringValues = (answers: StoredAnswer[]): string[] => answers.flatMap((answer) => (Array.isArray(answer.value) ? answer.value : [answer.value])).filter((value): value is string => typeof value === 'string');

export async function listFormResponses(actor: string, cardId: string, args: FormResponsesArgs): Promise<FormResponsesPage> {
  await requireResponsesAccess(actor, cardId);
  const all = (await prisma.formResponse.findMany({ where: { cardId, ...(args.blockId ? { blockId: args.blockId } : {}) }, select: { id: true, blockId: true, answers: true, status: true, createdAt: true } })).sort(newestFirst);

  const counts = { visible: 0, hidden: 0, pending: 0 };
  for (const row of all) {
    if (row.status === 'VISIBLE') counts.visible += 1;
    else if (row.status === 'HIDDEN') counts.hidden += 1;
    else counts.pending += 1;
  }

  let summary: FormSummaryView[] = [];
  if (args.blockId) {
    const block = findBlock(await publishedRoot(cardId), args.blockId);
    const fields = block && block.type === FORM_BLOCK ? parseFormBlock(block.props).fields : fieldsFromAnswers(all.flatMap((row) => storedAnswers(row.answers)));
    summary = summarize(fields, all);
  }

  const needle = args.search?.toLowerCase();
  let nodes = all.filter((row) => (!args.status || row.status === args.status) && (!needle || stringValues(storedAnswers(row.answers)).some((value) => value.toLowerCase().includes(needle))));
  if (args.after) {
    const cursor = decodeRowCursor(args.after);
    nodes = nodes.filter((row) => row.createdAt.getTime() < cursor.createdAt.getTime() || (row.createdAt.getTime() === cursor.createdAt.getTime() && row.id < cursor.id));
  }
  const page = nodes.slice(0, args.first);
  const last = page.at(-1);
  return {
    nodes: page.map((row) => ({ id: row.id, blockId: row.blockId, answers: storedAnswers(row.answers), status: row.status, createdAt: row.createdAt })),
    pageInfo: { hasNextPage: nodes.length > args.first, endCursor: last ? encodeRowCursor(last) : null },
    summary,
    counts,
  };
}

export async function deleteFormResponse(actor: string, id: string): Promise<void> {
  const row = await prisma.formResponse.findUnique({ where: { id }, select: { cardId: true } });
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  await requireResponsesAccess(actor, row.cardId);
  await prisma.formResponse.deleteMany({ where: { id } });
}

export async function setFormResponseStatus(actor: string, id: string, status: EntryStatusValue) {
  const row = await prisma.formResponse.findUnique({ where: { id }, select: { cardId: true } });
  if (!row) throw new AppError('NOT_FOUND', 'Not found');
  await requireResponsesAccess(actor, row.cardId);
  const updated = await prisma.formResponse.update({ where: { id }, data: { status }, select: { id: true, blockId: true, answers: true, status: true, createdAt: true } });
  return { ...updated, answers: storedAnswers(updated.answers) };
}

// ---- CSV ----

const VN_TIME = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// Tự ghép `dd/mm/yyyy hh:mm`: thứ tự thành phần trong chuỗi của Intl khác nhau giữa các bản ICU, còn bảng tính thì đọc
// theo thứ tự cột ngày giờ kiểu Việt Nam.
const vnTime = (date: Date): string => {
  const parts = Object.fromEntries(VN_TIME.formatToParts(date).map((piece) => [piece.type, piece.value]));
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
};

// Ô đầu bằng = + - @ hoặc ký tự điều khiển bị bảng tính hiểu là công thức (khách gõ được vào câu trả lời): chèn dấu nháy đơn phía trước.
const cell = (value: string | number | null | undefined): string => {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const valueText = (value: StoredAnswer['value'] | undefined): string => {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  return String(value);
};

// Tên tệp từ tiêu đề form, bỏ dấu để mọi trình duyệt và hệ tệp đều đọc được.
const fileSlug = (heading: string): string =>
  heading.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phan-hoi';

export async function exportFormCsv(actor: string, cardId: string, blockId: string): Promise<{ csv: string; filename: string }> {
  await requireResponsesAccess(actor, cardId);
  const block = findBlock(await publishedRoot(cardId), blockId);
  const config = block && block.type === FORM_BLOCK ? parseFormBlock(block.props) : null;
  const heading = config && typeof block?.props.heading === 'string' ? block.props.heading : '';

  const rows = await prisma.formResponse.findMany({ where: { cardId, blockId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const current = config?.fields ?? [];
  // Câu trả lời cho ô đã bị gỡ vẫn phải có cột, nếu không dữ liệu cũ biến mất khỏi tệp.
  const removed = new Map<string, string>();
  for (const row of rows) {
    for (const answer of storedAnswers(row.answers)) {
      if (!current.some((field) => field.id === answer.id)) removed.set(answer.id, answer.label);
    }
  }
  const columns = [...current.map((field) => ({ id: field.id, label: field.label })), ...[...removed].map(([id, label]) => ({ id, label }))];

  const header = ['Gửi lúc', ...columns.map((column) => cell(column.label))].join(',');
  const lines = rows.map((row) => {
    const answers = storedAnswers(row.answers);
    return [cell(vnTime(row.createdAt)), ...columns.map((column) => cell(valueText(answers.find((answer) => answer.id === column.id)?.value)))].join(',');
  });
  // BOM để Excel mở tệp UTF-8 đúng tiếng Việt; xuống dòng CRLF theo chuẩn CSV.
  return { csv: `﻿${[header, ...lines].join('\r\n')}\r\n`, filename: `${fileSlug(heading)}.csv` };
}
