import { prisma } from '../src/infra/prisma';
import catalog from '../src/modules/cards/photo-frame-catalog.json';

async function main() {
  for (const [sortOrder, shape] of catalog.entries()) {
    const existing = await prisma.photoFrameShape.findUnique({ where: { id: shape.id } });
    if (existing && (existing.geometry !== shape.geometry || (existing.maskPath ?? null) !== (shape.maskPath ?? null))) {
      throw new Error(`Geometry changed for ${shape.id}; create a new frame ID instead.`);
    }
    await prisma.photoFrameShape.upsert({
      where: { id: shape.id },
      create: {
        id: shape.id, label: shape.label, category: 'Khung ảnh', geometry: shape.geometry,
        maskPath: shape.maskPath ?? null, width: shape.size.w, height: shape.size.h,
        legacyType: shape.legacyType, sortOrder, status: 'PUBLISHED',
      },
      update: { label: shape.label, category: 'Khung ảnh', width: shape.size.w, height: shape.size.h, sortOrder },
    });
  }
  process.stdout.write(`Seeded ${catalog.length} frame shapes.\n`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
