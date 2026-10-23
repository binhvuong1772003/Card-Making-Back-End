import { prisma } from '../../src/infra/prisma';
import { signAccessToken } from '../../src/modules/auth/tokens';

// Tạo user trực tiếp trong DB và ký access token cho nó, không qua đăng ký/đăng nhập (nhanh, không tốn argon2).
// Access token không được đối chiếu với bảng Session nên không cần dựng phiên thật.
export async function createUserWithToken(email: string): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  const token = await signAccessToken({ userId: user.id, sessionId: '000000000000000000000000' });
  return { id: user.id, token };
}
