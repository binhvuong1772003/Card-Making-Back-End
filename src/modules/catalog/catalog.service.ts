import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { SHAPE_NAMES } from '@miditor/core';
import { prisma } from '../../infra/prisma';
import { AppError } from '../../shared/errors';

const shapeInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/), label: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(60), geometry: z.string().trim().min(1).max(40).refine((value) => value === 'custom' || (SHAPE_NAMES as readonly string[]).includes(value)),
  maskPath: z.string().max(4000).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9+.,\-\s]*$/).optional().nullable(),
  width: z.number().int().min(40).max(2000), height: z.number().int().min(40).max(2000),
  sortOrder: z.number().int().min(0).max(100000).default(0), legacyType: z.string().max(100).optional().nullable(),
});
const assetInput = z.object({
  name: z.string().trim().min(1).max(100), category: z.string().trim().min(1).max(60),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  publicId: z.string().regex(/^cardmaking\/decorations\/[A-Za-z0-9_\-/]+$/).max(240),
  url: z.string().url().max(1000), width: z.number().int().min(1).max(5000), height: z.number().int().min(1).max(5000),
  sortOrder: z.number().int().min(0).max(100000).default(0),
});
const objectId = z.string().regex(/^[0-9a-f]{24}$/i);
const firstArg = z.number().int().min(1).max(50).default(20);
const isAdmin = async (actor: string) => {
  const user = await prisma.user.findUnique({ where: { id: actor }, select: { role: true } });
  if (user?.role !== 'ADMIN') throw new AppError('FORBIDDEN', 'You do not have permission to do that');
};

type Cursor = { sortOrder: number; id: string };
function decodeCursor(value?: string | null): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (!Number.isInteger(parsed.sortOrder) || typeof parsed.id !== 'string') throw new Error();
    return parsed;
  } catch { throw new AppError('VALIDATION', 'Invalid catalog cursor'); }
}
const encodeCursor = (row: Cursor) => Buffer.from(JSON.stringify(row)).toString('base64url');

export async function listPhotoFrameShapes(firstValue?: number | null, after?: string | null) {
  const first = firstArg.parse(firstValue ?? undefined);
  const cursor = decodeCursor(after);
  const rows = await prisma.photoFrameShape.findMany({
    where: { status: 'PUBLISHED', ...(cursor ? { OR: [{ sortOrder: { gt: cursor.sortOrder } }, { sortOrder: cursor.sortOrder, id: { gt: cursor.id } }] } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: first + 1,
  });
  const nodes = rows.slice(0, first);
  const last = nodes[nodes.length - 1];
  return { nodes, pageInfo: { hasNextPage: rows.length > first, endCursor: last ? encodeCursor(last) : null } };
}

export async function listDecorativeAssets(category?: string | null, searchValue?: string | null, firstValue?: number | null, after?: string | null) {
  const first = firstArg.parse(firstValue ?? undefined);
  const cursor = decodeCursor(after);
  const search = z.string().trim().max(80).nullish().parse(searchValue) || undefined;
  const conditions: Prisma.DecorativeAssetWhereInput[] = [];
  if (search) conditions.push({ OR: [{ name: { contains: search, mode: 'insensitive' } }, { tags: { has: search } }] });
  if (cursor) conditions.push({ OR: [{ sortOrder: { gt: cursor.sortOrder } }, { sortOrder: cursor.sortOrder, id: { gt: cursor.id } }] });
  const rows = await prisma.decorativeAsset.findMany({
    where: { status: 'PUBLISHED', ...(category ? { category } : {}), ...(conditions.length ? { AND: conditions } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: first + 1,
  });
  const nodes = rows.slice(0, first);
  const last = nodes[nodes.length - 1];
  return { nodes, pageInfo: { hasNextPage: rows.length > first, endCursor: last ? encodeCursor(last) : null } };
}

export async function savePhotoFrameShape(actor: string, raw: unknown) {
  await isAdmin(actor);
  const input = shapeInput.parse(raw);
  if (input.geometry === 'custom' && !input.maskPath) throw new AppError('VALIDATION', 'A custom frame needs an SVG path');
  const existing = await prisma.photoFrameShape.findUnique({ where: { id: input.id } });
  if (existing && (existing.geometry !== input.geometry || existing.maskPath !== (input.maskPath ?? null))) {
    throw new AppError('CONFLICT', 'Frame geometry is immutable; use a new ID');
  }
  return prisma.photoFrameShape.upsert({ where: { id: input.id }, create: input, update: {
    label: input.label, category: input.category, width: input.width, height: input.height,
    sortOrder: input.sortOrder, legacyType: input.legacyType, status: 'PUBLISHED',
  } });
}

export async function retirePhotoFrameShape(actor: string, id: string) {
  await isAdmin(actor);
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new AppError('NOT_FOUND', 'Photo frame not found');
  const row = await prisma.photoFrameShape.update({ where: { id }, data: { status: 'RETIRED' } }).catch(() => null);
  if (!row) throw new AppError('NOT_FOUND', 'Photo frame not found');
  return row;
}

function validateCloudinaryAsset(input: z.infer<typeof assetInput>) {
  const cloudName = env.cloudinary?.cloudName;
  if (!cloudName) throw new AppError('PROVIDER_UNAVAILABLE', 'Image storage is not configured');
  let url: URL;
  try { url = new URL(input.url); } catch { throw new AppError('VALIDATION', 'Invalid image URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || !url.pathname.startsWith(`/${cloudName}/image/upload/`)) {
    throw new AppError('VALIDATION', 'Image must belong to the configured Cloudinary account');
  }
}

export async function createDecorativeAsset(actor: string, raw: unknown) {
  await isAdmin(actor);
  const input = assetInput.parse(raw);
  validateCloudinaryAsset(input);
  return prisma.decorativeAsset.create({ data: input });
}

export async function updateDecorativeAsset(actor: string, rawId: string, patch: Record<string, unknown>) {
  await isAdmin(actor);
  const id = objectId.parse(rawId);
  const data = z.object({ name: z.string().trim().min(1).max(100).optional(), category: z.string().trim().min(1).max(60).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(), sortOrder: z.number().int().min(0).max(100000).optional() }).strict().parse(patch);
  return prisma.decorativeAsset.update({ where: { id }, data }).catch(() => { throw new AppError('NOT_FOUND', 'Decorative asset not found'); });
}

export async function retireDecorativeAsset(actor: string, rawId: string) {
  await isAdmin(actor);
  const id = objectId.parse(rawId);
  return prisma.decorativeAsset.update({ where: { id }, data: { status: 'RETIRED' } }).catch(() => { throw new AppError('NOT_FOUND', 'Decorative asset not found'); });
}
