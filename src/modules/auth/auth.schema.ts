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

// Token đến từ link trong email, gửi bằng POST (không phải GET) để bộ quét thư và trình duyệt tải trước không "ăn" mất token.
export const verifyEmailBody = z.object({ token: z.string().min(1).max(200) });

export const resendVerificationBody = z.object({ email });

// Query của hai endpoint Google. Là các điều hướng của trình duyệt (không có body) và callback phải luôn trả 302,
// nên schema KHÔNG bao giờ từ chối: trường sai dạng (mảng, quá dài) thành undefined, handler coi như vắng mặt.
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

export const googleStartQuery = z.object({ returnTo: lenient(z.string().max(200)) });
export const googleCallbackQuery = z.object({
  code: lenient(z.string().min(1).max(2048)),
  state: lenient(z.string().min(1).max(512)),
  error: lenient(z.string().max(100)),
});

export type GoogleStartQuery = z.infer<typeof googleStartQuery>;
export type GoogleCallbackQuery = z.infer<typeof googleCallbackQuery>;

export type RegisterBody = z.infer<typeof registerBody>;
export type VerifyEmailBody = z.infer<typeof verifyEmailBody>;
export type ResendVerificationBody = z.infer<typeof resendVerificationBody>;
export type LoginBody = z.infer<typeof loginBody>;
