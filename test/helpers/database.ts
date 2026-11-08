import { prisma } from '../../src/infra/prisma';

// Mọi file test dùng chung một database. Xóa theo thứ tự phụ thuộc: user.deleteMany() bị chặn (Restrict) nếu còn bản ghi
// nào trỏ tới nó, kể cả do file test khác để lại. Dùng ở beforeEach và afterAll của file nào tạo Card/User.
export async function resetDatabase(): Promise<void> {
  await prisma.session.deleteMany();
  await prisma.identity.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.formResponse.deleteMany();
  await prisma.publication.deleteMany();
  await prisma.cardInvite.deleteMany();
  await prisma.card.deleteMany();
  await prisma.template.deleteMany();
  await prisma.user.deleteMany();
}
