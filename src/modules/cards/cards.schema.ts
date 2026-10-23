import { z } from 'zod';

// GraphQL chỉ kiểm kiểu (String!); luật về nội dung nằm ở đây. Dùng lại cho đổi tiêu đề sau này.
export const cardTitle = z.string().trim().min(1).max(100);

export const createCardInput = z.object({ title: cardTitle });

export type CreateCardInput = z.infer<typeof createCardInput>;
