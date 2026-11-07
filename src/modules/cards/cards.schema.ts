import { z } from 'zod';
import { AppError } from '../../shared/errors';

// GraphQL chỉ kiểm kiểu (String!); luật về nội dung nằm ở đây.
export const cardTitle = z.string().trim().min(1).max(100);

export const cardOccasion = z.enum(['WEDDING', 'BIRTHDAY', 'EVENT', 'OTHER']);
export type CardOccasion = z.infer<typeof cardOccasion>;

export const createCardInput = z.object({ title: cardTitle, occasion: cardOccasion.optional() });
export const updateCardTitleInput = z.object({ title: cardTitle });

export type CreateCardInput = z.infer<typeof createCardInput>;
export type UpdateCardTitleInput = z.infer<typeof updateCardTitleInput>;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// Id sai dạng được coi như thiệp không tồn tại (NOT_FOUND) chứ không phải lỗi nhập liệu: người ngoài không phân biệt
// được "không có thiệp này" với "có nhưng không phải của bạn", và Prisma sẽ ném lỗi khó hiểu với id không phải ObjectId.
export function parseCardId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new AppError('NOT_FOUND', 'Card not found');
  return value;
}

// Danh sách: first từ 1 đến 50 (ngoài khoảng thì báo lỗi chứ không âm thầm cắt), after là con trỏ do server cấp.
export const listCardsArgs = z.object({
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().min(1).max(200).optional(),
  occasion: cardOccasion.optional(),
  // Tìm trong tiêu đề; cắt khoảng trắng, chuỗi rỗng coi như không tìm.
  search: z.string().trim().max(100).optional(),
});
export type ListCardsArgs = z.infer<typeof listCardsArgs>;

// Con trỏ mờ cho client: base64url của "<updatedAt tính bằng ms>:<id>". Sắp xếp theo (updatedAt giảm dần, id giảm dần),
// nên cặp này xác định đúng vị trí và ổn định kể cả khi nhiều thiệp trùng updatedAt.
const CURSOR = /^(\d{1,16}):([0-9a-f]{24})$/;

export const encodeCursor = (card: { updatedAt: Date; id: string }): string =>
  Buffer.from(`${card.updatedAt.getTime()}:${card.id}`).toString('base64url');

export function decodeCursor(value: string): { updatedAt: Date; id: string } {
  const match = CURSOR.exec(Buffer.from(value, 'base64url').toString('utf8'));
  const updatedAt = match ? new Date(Number(match[1])) : undefined;
  if (!match || !updatedAt || Number.isNaN(updatedAt.getTime())) throw new AppError('VALIDATION', 'Invalid cursor');
  return { updatedAt, id: match[2] };
}
