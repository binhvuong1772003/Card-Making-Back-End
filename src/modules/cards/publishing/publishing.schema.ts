import { z } from 'zod';
import { AppError } from '../../../shared/errors';

// Slug: chữ thường, số, gạch nối giữa các đoạn; 3 đến 60 ký tự. Chuỗi rỗng coi như không đặt.
export const slugSchema = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const publishArgs = z.object({ slug: slugSchema.optional() });

// Tên bản: tối đa 40 ký tự, không ký tự điều khiển. Chuỗi rỗng là bỏ tên.
export const labelSchema = z
  .string()
  .trim()
  .max(40)
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), 'Control characters are not allowed');

export const publishInput = z.object({
  publicationId: z.string().optional(),
  slug: slugSchema.optional(),
  label: labelSchema.optional(),
});

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// Id bản sai dạng coi như không có (NOT_FOUND), như mọi id khác của dự án.
export function parsePublicationId(value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new AppError('NOT_FOUND', 'Publication not found');
  return value;
}
