import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

// passwordHash bị ẩn theo mặc định ở mọi truy vấn; chỗ nào cần thì ghi rõ `omit: { passwordHash: false }`.
export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  omit: { user: { passwordHash: true } },
});
