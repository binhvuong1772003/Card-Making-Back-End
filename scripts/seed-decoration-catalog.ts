import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env';
import { signParams } from '../src/infra/cloudinary';
import { prisma } from '../src/infra/prisma';

const FOLDER = 'cardmaking/decorations';
const ALLOWED_FORMATS = 'png,webp';
const TRANSFORMATION = 'c_limit,h_3000,w_3000';
const ASSETS = [
  { id: 'starter-olive-branch', file: 'olive-branch.png', name: 'Cành olive', category: 'Hoa & lá', tags: ['lá', 'cành', 'olive', 'đổi màu'] },
  { id: 'starter-botanical-corners', file: 'botanical-corners.png', name: 'Lá góc', category: 'Hoa & lá', tags: ['lá', 'góc', 'hoa', 'đổi màu'] },
  { id: 'starter-song-hy-emblem', file: 'song-hy-emblem.png', name: 'Song Hỷ', category: 'Biểu tượng', tags: ['song hỷ', 'đám cưới', 'đổi màu'] },
  { id: 'starter-sparkle-cluster', file: 'sparkle-cluster.png', name: 'Lấp lánh', category: 'Điểm nhấn', tags: ['lấp lánh', 'sao', 'đổi màu'] },
  { id: 'starter-floral-divider', file: 'floral-divider.png', name: 'Ngăn cách hoa lá', category: 'Đường viền', tags: ['hoa', 'ngăn cách', 'đổi màu'] },
  { id: 'starter-faint-leaf-pattern', file: 'faint-leaf-pattern.png', name: 'Lá nền mờ', category: 'Nền & họa tiết', tags: ['lá', 'nền', 'họa tiết'] },
  { id: 'starter-wedding-gift-box', file: 'gift-box.webp', name: 'Hộp quà', category: 'Điểm nhấn', tags: ['quà cưới', 'hộp quà', 'hiệu ứng hộp quà'] },
  { id: 'ref-min-red-paper-texture', file: 'minimalism-red-paper.webp', name: 'Giấy kem Minimalism đỏ', category: 'Nền & họa tiết', tags: ['giấy', 'nền', 'minimalism', 'đỏ đậm'] },
  { id: 'ref-min-red-envelope-open', file: 'minimalism-red-envelope-open.webp', name: 'Phong bì đỏ mở', category: 'Phong bì', tags: ['phong bì', 'minimalism', 'đỏ đậm'] },
  { id: 'ref-min-red-envelope-front', file: 'minimalism-red-envelope-front.webp', name: 'Mặt trước phong bì đỏ', category: 'Phong bì', tags: ['phong bì', 'minimalism', 'đỏ đậm'] },
  { id: 'ref-min-red-envelope-pair', file: 'minimalism-red-envelope-pair.webp', name: 'Cặp bao lì xì hoa đỏ (bản hiện tại)', category: 'Phong bì', tags: ['bao lì xì', 'phong bì', 'hoa đỏ', 'minimalism', 'đỏ đậm'] },
] as const;

async function upload(file: string, publicId: string) {
  const cloud = env.cloudinary;
  if (!cloud) throw new Error('CLOUDINARY_URL is required to seed decoration assets.');
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = {
    allowed_formats: ALLOWED_FORMATS,
    folder: FOLDER,
    overwrite: 'true',
    public_id: publicId,
    timestamp,
    transformation: TRANSFORMATION,
  };
  const body = new FormData();
  const mimeType = path.extname(file) === '.webp' ? 'image/webp' : 'image/png';
  body.set('file', new Blob([await readFile(file)], { type: mimeType }), path.basename(file));
  body.set('api_key', cloud.apiKey);
  for (const [key, value] of Object.entries(signed)) body.set(key, String(value));
  body.set('signature', signParams(signed, cloud.apiSecret));

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloud.cloudName}/image/upload`, { method: 'POST', body });
  const result = await response.json() as { secure_url?: string; public_id?: string; width?: number; height?: number; error?: { message?: string } };
  if (!response.ok || !result.secure_url || !result.public_id || !result.width || !result.height) {
    throw new Error(result.error?.message ?? `Cloudinary upload failed (${response.status}).`);
  }
  return { url: result.secure_url, publicId: result.public_id, width: result.width, height: result.height };
}

async function main() {
  const onlyId = process.argv[2];
  if (onlyId && !ASSETS.some((asset) => asset.id === onlyId)) throw new Error(`Unknown decoration asset: ${onlyId}`);
  for (const [sortOrder, asset] of ASSETS.entries()) {
    if (onlyId && asset.id !== onlyId) continue;
    const file = path.resolve('scripts/assets/decorations', asset.file);
    const uploaded = await upload(file, asset.id);
    await prisma.decorativeAsset.upsert({
      where: { publicId: uploaded.publicId },
      create: {
        name: asset.name, category: asset.category, tags: [...asset.tags], ...uploaded,
        sortOrder, status: 'PUBLISHED',
      },
      update: {
        name: asset.name, category: asset.category, tags: [...asset.tags], url: uploaded.url,
        width: uploaded.width, height: uploaded.height, sortOrder, status: 'PUBLISHED',
      },
    });
  }
  process.stdout.write(`Seeded ${onlyId ? 1 : ASSETS.length} decoration assets to MongoDB and Cloudinary.\n`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
