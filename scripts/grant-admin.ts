// Cấp quyền admin (duyệt thư viện công khai) cho tài khoản đã đăng ký. Không có giao diện cấp quyền, nên chạy bằng tay:
//   npm run grant-admin -- email1@example.com email2@example.com
// hoặc đặt ADMIN_EMAILS="a@example.com,b@example.com" rồi chạy `npm run grant-admin`.
import { prisma } from '../src/infra/prisma';

const fromArgs = process.argv.slice(2);
const emails = (fromArgs.length > 0 ? fromArgs : (process.env.ADMIN_EMAILS ?? '').split(','))
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

async function main(): Promise<void> {
  if (emails.length === 0) {
    console.error('Chưa có email nào: truyền email làm tham số hoặc đặt ADMIN_EMAILS.');
    process.exitCode = 1;
    return;
  }
  for (const email of emails) {
    const { count } = await prisma.user.updateMany({ where: { email }, data: { role: 'ADMIN' } });
    console.log(count > 0 ? `Đã cấp admin: ${email}` : `Không tìm thấy tài khoản: ${email}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
