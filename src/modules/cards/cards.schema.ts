import { z } from 'zod';
import { AppError } from '../../shared/errors';

// GraphQL chỉ kiểm kiểu (String!); luật về nội dung nằm ở đây.
export const cardTitle = z.string().trim().min(1).max(100);

export const createCardInput = z.object({ title: cardTitle });
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
