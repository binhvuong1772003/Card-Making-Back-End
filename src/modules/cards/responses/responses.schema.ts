import { z } from 'zod';
import { AppError } from '../../../shared/errors';

// Luật đầu vào của form công khai và của các truy vấn của chủ thiệp. GraphQL chỉ kiểm kiểu; luật về nội dung nằm ở đây.
const blockId = z.string().min(1).max(100);

// Khách gửi câu trả lời theo bản đồ mã ô → giá trị; luật nội dung của từng ô nằm ở `form-fields.ts` vì phải đọc cấu hình form.
export const formInput = z.object({
  blockId,
  answers: z.record(z.string(), z.unknown()).default({}),
  // Ô ẩn chống thư rác: người điền thật không thấy nên để trống.
  website: z.string().max(200).optional(),
});
export type FormInput = z.infer<typeof formInput>;

export const entriesQuery = z.object({
  blockId,
  first: z.coerce.number().int().min(1).max(50).default(10),
  after: z.string().min(1).max(200).optional(),
});

export const entryStatus = z.enum(['VISIBLE', 'HIDDEN', 'PENDING']);
export type EntryStatusValue = z.infer<typeof entryStatus>;

export const formResponsesArgs = z.object({
  blockId: blockId.optional(),
  // Lọc theo bản xuất bản (liên kết) mà khách đã điền qua.
  publicationId: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
  status: entryStatus.optional(),
  search: z.string().trim().max(100).optional(),
  first: z.number().int().min(1).max(100).default(20),
  after: z.string().min(1).max(200).optional(),
});
export type FormResponsesArgs = z.infer<typeof formResponsesArgs>;

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
