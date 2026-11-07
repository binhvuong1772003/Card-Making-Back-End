// Dọn ảnh mồ côi trong kho Cloudinary: ảnh không còn thiệp, bản xuất bản hay mẫu nào dùng và đã tải lên đủ lâu. Mặc định CHỈ BÁO CÁO.
//   npm run sweep-images                       báo cáo, không xoá gì
//   npm run sweep-images -- --delete           xoá thật
//   npm run sweep-images -- --min-age-days=14  chỉ ảnh cũ hơn 14 ngày (mặc định 7)
//   npm run sweep-images -- --delete --force   cho phép xoá hơn nửa kho (chỉ khi báo cáo đã xem và đúng)
// Không bao giờ đụng thư mục chung của mẫu (cardmaking/templates/).
import { env } from '../src/config/env';
import { prisma } from '../src/infra/prisma';
import { liveSweepDeps, sweepImages } from '../src/modules/assets/assets.sweep';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const ageArg = args.find((arg) => arg.startsWith('--min-age-days='));
const minAgeDays = ageArg ? Number(ageArg.split('=')[1]) : 7;

async function main(): Promise<void> {
  if (!env.cloudinary) throw new Error('CLOUDINARY_URL chưa được cấu hình');
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) throw new Error('--min-age-days phải là một số không âm');
  const apply = flag('--delete');
  const report = await sweepImages({ ...liveSweepDeps(env.cloudinary, 'cardmaking/'), apply, force: flag('--force'), now: Date.now(), minAgeDays, prefix: 'cardmaking/' });
  console.log(`Ảnh trong kho: ${report.total}. Mồ côi (cũ hơn ${minAgeDays} ngày, không ai dùng): ${report.orphans.length}.`);
  for (const orphan of report.orphans.slice(0, 20)) console.log(`  ${orphan.publicId}  (${orphan.createdAt})`);
  if (report.orphans.length > 20) console.log(`  ... và ${report.orphans.length - 20} ảnh nữa`);
  console.log(apply ? `Đã xoá: ${report.deleted}.` : 'Chưa xoá gì (báo cáo). Thêm --delete để xoá thật.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
