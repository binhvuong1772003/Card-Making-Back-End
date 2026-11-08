import { z } from 'zod';
import { AppError } from '../../../shared/errors';

// Luật đầu vào của form công khai và của các truy vấn của chủ thiệp. GraphQL chỉ kiểm kiểu; luật về nội dung nằm ở đây.
const blockId = z.string().min(1).max(100);

// Không nhận ký tự điều khiển (trừ xuống dòng và tab trong lời nhắn), vì chúng làm hỏng bảng tính và nhật ký.
const noControl = (value: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine(noControl, 'Control characters are not allowed');
// Ô tuỳ chọn: chuỗi rỗng hoặc toàn khoảng trắng coi như không điền.
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

export const rsvpAnswer = z.enum(['YES', 'NO', 'MAYBE']);
export type RsvpAnswerValue = z.infer<typeof rsvpAnswer>;

export const rsvpInput = z.object({
  blockId,
  name: text(1, 100),
  attending: rsvpAnswer,
  guests: z.number().int().min(1).max(100).optional(),
  phone: optional(text(6, 20).regex(/^[0-9+().\-\s]+$/, 'Invalid phone number')),
  note: optional(text(1, 500)),
  // Ô ẩn chống thư rác: người điền thật không thấy nên để trống.
  website: z.string().max(200).optional(),
});
export type RsvpInput = z.infer<typeof rsvpInput>;

export const guestbookInput = z.object({
  blockId,
  name: text(1, 60),
  message: text(1, 500),
  website: z.string().max(200).optional(),
});
export type GuestbookInput = z.infer<typeof guestbookInput>;

export const entryStatus = z.enum(['VISIBLE', 'HIDDEN', 'PENDING']);
export type EntryStatusValue = z.infer<typeof entryStatus>;

export const guestbookQuery = z.object({
  blockId,
  first: z.coerce.number().int().min(1).max(50).default(10),
  after: z.string().min(1).max(200).optional(),
});

export const listRsvpsArgs = z.object({
  blockId: blockId.optional(),
  answer: rsvpAnswer.optional(),
  search: z.string().trim().max(100).optional(),
  first: z.number().int().min(1).max(100).default(20),
  after: z.string().min(1).max(200).optional(),
});
export type ListRsvpsArgs = z.infer<typeof listRsvpsArgs>;

export const listEntriesArgs = z.object({
  blockId: blockId.optional(),
  status: entryStatus.optional(),
  first: z.number().int().min(1).max(100).default(20),
  after: z.string().min(1).max(200).optional(),
});
export type ListEntriesArgs = z.infer<typeof listEntriesArgs>;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// Id sai dạng coi như không có (NOT_FOUND), như mọi id khác của dự án.
export function parseRowId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new AppError('NOT_FOUND', 'Not found');
  return value;
}

// Con trỏ mờ: base64url của "<createdAt ms>:<id>". Sắp xếp (createdAt giảm dần, id giảm dần) nên cặp này xác định đúng vị trí.
const CURSOR = /^(\d{1,16}):([0-9a-f]{24})$/;

export const encodeRowCursor = (row: { createdAt: Date; id: string }): string => Buffer.from(`${row.createdAt.getTime()}:${row.id}`).toString('base64url');

export function decodeRowCursor(value: string): { createdAt: Date; id: string } {
  const match = CURSOR.exec(Buffer.from(value, 'base64url').toString('utf8'));
  const createdAt = match ? new Date(Number(match[1])) : undefined;
  if (!match || !createdAt || Number.isNaN(createdAt.getTime())) throw new AppError('VALIDATION', 'Invalid cursor');
  return { createdAt, id: match[2] as string };
}
