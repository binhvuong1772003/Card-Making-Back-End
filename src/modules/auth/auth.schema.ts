import { z } from 'zod';

// Chuẩn hóa email trước mọi truy vấn: chỉ mục duy nhất của database phân biệt hoa thường.
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const registerBody = z.object({
  email,
  // Có trần độ dài để đầu vào khổng lồ không biến việc băm argon2 thành đường làm cạn tài nguyên.
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100).optional(),
});

// Đăng nhập không nêu quy tắc độ dài tối thiểu, tránh lộ chính sách mật khẩu.
export const loginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
