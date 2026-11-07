import { z } from 'zod';

// Slug: chữ thường, số, gạch nối giữa các đoạn; 3 đến 60 ký tự. Chuỗi rỗng coi như không đặt.
export const slugSchema = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const publishArgs = z.object({ slug: slugSchema.optional() });
