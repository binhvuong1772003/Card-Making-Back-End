import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env';
import { signParams } from '../src/infra/cloudinary';
import { prisma } from '../src/infra/prisma';

const FOLDER = 'cardmaking/decorations';
const ALLOWED_FORMATS = 'png,webp';
const TRANSFORMATION = 'c_limit,h_3000,w_3000';
const ASSETS = [
  { id: 'starter-olive-branch', file: 'olive-branch.png', name: 'Cành olive', category: 'Hoa lá', tags: ['lá', 'cành', 'olive', 'đổi màu'] },
  { id: 'starter-botanical-corners', file: 'botanical-corners.png', name: 'Lá góc', category: 'Hoa lá', tags: ['lá', 'góc', 'hoa', 'đổi màu'] },
  { id: 'starter-song-hy-emblem', file: 'song-hy-emblem.png', name: 'Song Hỷ', category: 'Biểu tượng', tags: ['song hỷ', 'đám cưới', 'đổi màu'] },
  { id: 'ref-songhy-green-star', file: 'song-hy-green-star.webp', name: 'Ngôi sao Song Hỷ xanh', category: 'Biểu tượng', tags: ['song hỷ', 'xanh', 'ngôi sao', 'chữ cong'] },
  { id: 'ref-songhy-source-emblem', file: 'song-hy-source-emblem.webp', name: 'Chữ Hỷ Song Hỷ', category: 'Biểu tượng', tags: ['song hỷ', 'xanh', 'chữ hỷ', 'đổi màu'] },
  { id: 'starter-sparkle-cluster', file: 'sparkle-cluster.png', name: 'Lấp lánh', category: 'Biểu tượng', tags: ['lấp lánh', 'sao', 'đổi màu'] },
  { id: 'starter-floral-divider', file: 'floral-divider.png', name: 'Ngăn cách hoa lá', category: 'Viền & nền', tags: ['hoa', 'ngăn cách', 'đổi màu'] },
  { id: 'starter-faint-leaf-pattern', file: 'faint-leaf-pattern.png', name: 'Lá nền mờ', category: 'Viền & nền', tags: ['lá', 'nền', 'họa tiết'] },
  { id: 'starter-wedding-gift-box', file: 'gift-box.webp', name: 'Hộp quà', category: 'Phong bì & quà', tags: ['quà cưới', 'hộp quà', 'hiệu ứng hộp quà'] },
  { id: 'ref-min-red-paper-texture', file: 'minimalism-red-paper.webp', name: 'Giấy kem Minimalism đỏ', category: 'Viền & nền', tags: ['giấy', 'nền', 'minimalism', 'đỏ đậm'] },
  { id: 'ref-min-red-envelope-open', file: 'minimalism-red-envelope-open.webp', name: 'Phong bì đỏ mở', category: 'Phong bì & quà', tags: ['phong bì', 'minimalism', 'đỏ đậm'] },
  { id: 'ref-min-red-envelope-front', file: 'minimalism-red-envelope-front.webp', name: 'Mặt trước phong bì đỏ', category: 'Phong bì & quà', tags: ['phong bì', 'minimalism', 'đỏ đậm'] },
  { id: 'ref-min-red-envelope-pair', file: 'minimalism-red-envelope-pair.webp', name: 'Cặp bao lì xì hoa đỏ (bản hiện tại)', category: 'Phong bì & quà', tags: ['bao lì xì', 'phong bì', 'hoa đỏ', 'minimalism', 'đỏ đậm'] },
  { id: 'ref-hoa-moc-green-flowers', file: 'hoa-moc-xanh-flowers.webp', name: 'Cụm hoa Hoa Mộc Xanh', category: 'Hoa lá', tags: ['hoa', 'lá xanh', 'hoa mộc xanh', 'boho'] },
  { id: 'ref-hoa-moc-green-floral-band', file: 'hoa-moc-xanh-floral-band.webp', name: 'Dải hoa Hoa Mộc Xanh', category: 'Viền & nền', tags: ['hoa', 'dải hoa', 'hoa mộc xanh', 'boho'] },
  { id: 'ref-hoa-moc-green-gift', file: 'hoa-moc-xanh-gift.webp', name: 'Hộp quà Hoa Mộc Xanh', category: 'Phong bì & quà', tags: ['quà cưới', 'hộp quà', 'hoa mộc xanh'] },
  { id: 'ref-hoa-moc-green-gift-mini-orbit', file: 'hoa-moc-xanh-gift-mini-orbit.webp', name: 'Cụm hộp quà nhỏ Hoa Mộc Xanh', category: 'Phong bì & quà', tags: ['quà cưới', 'hộp quà nhỏ', 'hoa mộc xanh', 'cụm trang trí'] },
  { id: 'ref-min-brown-flower', file: 'minimalism-brown-flower2-decoration.webp', name: 'Cụm hoa khô Minimalism Nâu', category: 'Hoa lá', tags: ['hoa', 'hoa khô', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-leaf', file: 'minimalism-brown-leaf-background.webp', name: 'Lá nền Minimalism Nâu', category: 'Viền & nền', tags: ['lá', 'nền', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-house', file: 'minimalism-brown-house-background.webp', name: 'Nền kiến trúc Minimalism Nâu', category: 'Viền & nền', tags: ['kiến trúc', 'nền', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-avatar-frame', file: 'minimalism-brown-frame-avatar.webp', name: 'Khung ảnh hoa Minimalism Nâu', category: 'Khung ảnh', tags: ['khung ảnh', 'hoa', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-paper', file: 'minimalism-brown-paper.webp', name: 'Giấy vân Minimalism Nâu', category: 'Viền & nền', tags: ['giấy', 'texture', 'nền', 'minimalism'] },
  { id: 'ref-min-brown-paper-note', file: 'minimalism-brown-paper-note.webp', name: 'Giấy ghi chú Minimalism Nâu', category: 'Viền & nền', tags: ['giấy', 'ghi chú', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-gate', file: 'minimalism-brown-gate.webp', name: 'Cổng cưới minh họa', category: 'Biểu tượng', tags: ['cổng', 'lịch trình', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-cake', file: 'minimalism-brown-cake.webp', name: 'Bánh cưới minh họa', category: 'Biểu tượng', tags: ['bánh cưới', 'lịch trình', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-water', file: 'minimalism-brown-water.webp', name: 'Ly cưới minh họa', category: 'Biểu tượng', tags: ['ly cưới', 'lịch trình', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-gift-main', file: 'minimalism-brown-gift-main.webp', name: 'Hộp quà Minimalism Nâu', category: 'Phong bì & quà', tags: ['quà cưới', 'hộp quà', 'minimalism', 'nâu'] },
  { id: 'ref-min-brown-gift-mini-minimalism-purple', file: 'minimalism-brown-gift-mini-minimalism_purple.webp', name: 'Hộp quà nhỏ tím Minimalism', category: 'Phong bì & quà', tags: ['quà nhỏ', 'hộp quà', 'minimalism'] },
  { id: 'ref-min-brown-gift-mini-song-hac-red', file: 'minimalism-brown-gift-mini-song_hac_red.webp', name: 'Hộp quà nhỏ Song Hạc đỏ', category: 'Phong bì & quà', tags: ['quà nhỏ', 'song hạc', 'hộp quà'] },
  { id: 'ref-min-brown-gift-mini-minimalism-darkred', file: 'minimalism-brown-gift-mini-minimalism_darkred.webp', name: 'Hộp quà nhỏ đỏ đậm Minimalism', category: 'Phong bì & quà', tags: ['quà nhỏ', 'hộp quà', 'minimalism'] },
  { id: 'ref-min-brown-gift-mini-spring-garden-blue', file: 'minimalism-brown-gift-mini-spring_garden_blue.webp', name: 'Hộp quà nhỏ vườn xuân xanh', category: 'Phong bì & quà', tags: ['quà nhỏ', 'hộp quà', 'xanh'] },
  { id: 'ref-min-brown-gift-mini-porcelain-brown', file: 'minimalism-brown-gift-mini-porcelain_brown.webp', name: 'Hộp quà nhỏ sứ nâu', category: 'Phong bì & quà', tags: ['quà nhỏ', 'hộp quà', 'sứ', 'nâu'] },
  { id: 'ref-min-brown-gift-mini-porcelain-v2-pink', file: 'minimalism-brown-gift-mini-porcelain_v2_pink.webp', name: 'Hộp quà nhỏ sứ hồng', category: 'Phong bì & quà', tags: ['quà nhỏ', 'hộp quà', 'sứ', 'hồng'] },
  { id: 'ref-min-brown-gift-mini-double-dragon-red', file: 'minimalism-brown-gift-mini-double_dragon_red.webp', name: 'Hộp quà nhỏ song long đỏ', category: 'Phong bì & quà', tags: ['quà nhỏ', 'hộp quà', 'song long', 'đỏ'] },
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
  const onlyIds = new Set(process.argv.slice(2).flatMap((arg) => arg.split(',')).filter(Boolean));
  const unknown = [...onlyIds].filter((id) => !ASSETS.some((asset) => asset.id === id));
  if (unknown.length) throw new Error(`Unknown decoration asset: ${unknown.join(', ')}`);
  for (const [sortOrder, asset] of ASSETS.entries()) {
    if (onlyIds.size && !onlyIds.has(asset.id)) continue;
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
  process.stdout.write(`Seeded ${onlyIds.size || ASSETS.length} decoration assets to MongoDB and Cloudinary.\n`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
