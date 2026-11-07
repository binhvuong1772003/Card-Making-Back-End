import { z } from 'zod';
import { cardOccasion } from '../cards.schema';

export const templateStatus = z.enum(['PENDING', 'PUBLISHED', 'REJECTED', 'UNLISTED', 'REMOVED']);
export type TemplateStatus = z.infer<typeof templateStatus>;

// Lý do từ chối: bắt buộc, cắt khoảng trắng, tối đa 500 ký tự.
export const rejectReason = z.string().trim().min(1).max(500);

export const listTemplatesArgs = z.object({
  category: cardOccasion.optional(),
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().min(1).max(200).optional(),
});
export type ListTemplatesArgs = z.infer<typeof listTemplatesArgs>;

export const adminListArgs = z.object({
  status: templateStatus,
  first: z.number().int().min(1).max(50).default(20),
  after: z.string().min(1).max(200).optional(),
});
