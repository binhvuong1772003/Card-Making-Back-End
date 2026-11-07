import { deleteImages, listImages, type CloudinaryConfig, type ImageResource } from '../../infra/cloudinary';
import { prisma } from '../../infra/prisma';

// Dọn ảnh mồ côi: ảnh nằm trong kho nhưng không còn thiệp, bản xuất bản hay mẫu nào trỏ tới (người dùng đổi hoặc bỏ ảnh, xoá thiệp).
// Không xoá lúc người dùng đổi ảnh vì còn hoàn tác, bản xuất bản và mẫu có thể vẫn dùng ảnh đó; dọn định kỳ và chỉ ảnh đủ cũ.
// Thư mục chung của mẫu (`cardmaking/templates/`) không bao giờ bị dọn.
export const SHARED_PREFIX = 'cardmaking/templates/';
const CLOUDINARY_STRING = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(.+)$/;
const VERSION_SEGMENT = /^v\d+$/;

// Các public_id mà một địa chỉ ảnh của kho `cloudName` có thể chỉ tới. Địa chỉ có phiên bản (`v123`, luôn có với địa chỉ Cloudinary
// trả về) chỉ có một: phần sau phiên bản, bỏ đuôi file. Địa chỉ không có phiên bản có thể kèm đoạn biến đổi (`c_limit,w_800`) ở đầu,
// nên tính mọi cách cắt bớt đoạn đầu: nhận thừa thì chỉ giữ lại thêm ảnh, không bao giờ xoá nhầm ảnh đang dùng.
export function publicIdCandidates(address: string, cloudName: string): string[] {
  const match = CLOUDINARY_STRING.exec(address);
  if (!match || match[1] !== cloudName) return [];
  const segments = match[2]!.split('/');
  const version = segments.findIndex((segment) => VERSION_SEGMENT.test(segment));
  const strip = (parts: string[]): string => parts.join('/').replace(/\.[A-Za-z0-9]+$/, '');
  const candidates = version >= 0 ? [strip(segments.slice(version + 1))] : segments.map((_, start) => strip(segments.slice(start)));
  return candidates.filter(Boolean);
}

// public_id chính của một địa chỉ ảnh (đầy đủ nhất), hoặc undefined nếu không thuộc kho này.
export const publicIdFromUrl = (address: string, cloudName: string): string | undefined => publicIdCandidates(address, cloudName)[0];

// Mọi public_id của kho mình được tham chiếu ở bất kỳ đâu trong các tài liệu (chỉ tính chuỗi là một địa chỉ ảnh nguyên vẹn).
export function collectReferencedPublicIds(documents: Iterable<unknown>, cloudName: string): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const id of publicIdCandidates(node, cloudName)) found.add(id);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  for (const document of documents) walk(document);
  return found;
}

// Ảnh không ai dùng, đủ cũ, và không nằm trong thư mục chung. Không biết tuổi (ngày sai) thì giữ lại.
export function findOrphans(input: { resources: readonly ImageResource[]; referenced: ReadonlySet<string>; now: number; minAgeMs: number }): ImageResource[] {
  return input.resources.filter((resource) => {
    if (resource.publicId.startsWith(SHARED_PREFIX) || input.referenced.has(resource.publicId)) return false;
    const created = Date.parse(resource.createdAt);
    return Number.isFinite(created) && input.now - created >= input.minAgeMs;
  });
}

export interface SweepDeps {
  list: () => Promise<ImageResource[]>;
  referenced: () => Promise<Set<string>>;
  remove: (publicIds: string[]) => Promise<number>;
}
export interface SweepOptions extends SweepDeps {
  apply: boolean;
  force: boolean;
  now: number;
  minAgeDays: number;
  prefix: string;
}
export interface SweepReport {
  total: number;
  orphans: ImageResource[];
  deleted: number;
}

// Một số lượng xoá bất thường (hơn nửa kho và hơn 20 ảnh) giống hệt lỗi đọc thiếu tài liệu, nên không tự xoá: cần `force`.
const MASS_DELETE_MIN = 20;

export async function sweepImages(options: SweepOptions): Promise<SweepReport> {
  const [resources, referenced] = await Promise.all([options.list(), options.referenced()]);
  const orphans = findOrphans({ resources, referenced, now: options.now, minAgeMs: options.minAgeDays * 24 * 60 * 60 * 1000 });
  const report: SweepReport = { total: resources.length, orphans, deleted: 0 };
  if (!options.apply || orphans.length === 0) return report;
  if (!options.force && orphans.length > MASS_DELETE_MIN && orphans.length > resources.length / 2) {
    throw new Error(`Refusing to delete ${orphans.length} of ${resources.length} images; check the result of a dry run, then use --force if it is right`);
  }
  report.deleted = await options.remove(orphans.map((orphan) => orphan.publicId));
  return report;
}

// Đọc mọi tài liệu có thể chứa địa chỉ ảnh (bản nháp, bản xuất bản, mẫu ở mọi trạng thái), từng lô để không nạp hết vào bộ nhớ.
async function* allDocuments(): AsyncGenerator<unknown> {
  const BATCH = 200;
  for (let skip = 0; ; skip += BATCH) {
    const rows = await prisma.card.findMany({ select: { document: true }, orderBy: { id: 'asc' }, skip, take: BATCH });
    for (const row of rows) yield row.document;
    if (rows.length < BATCH) break;
  }
  for (let skip = 0; ; skip += BATCH) {
    const rows = await prisma.publication.findMany({ select: { document: true }, orderBy: { id: 'asc' }, skip, take: BATCH });
    for (const row of rows) yield row.document;
    if (rows.length < BATCH) break;
  }
  for (let skip = 0; ; skip += BATCH) {
    const rows = await prisma.template.findMany({ select: { snapshot: true }, orderBy: { id: 'asc' }, skip, take: BATCH });
    for (const row of rows) yield row.snapshot;
    if (rows.length < BATCH) break;
  }
}

export async function referencedFromDatabase(cloudName: string): Promise<Set<string>> {
  const documents: unknown[] = [];
  for await (const document of allDocuments()) documents.push(document);
  return collectReferencedPublicIds(documents, cloudName);
}

// Phiên bản chạy thật: kho Cloudinary và cơ sở dữ liệu.
export const liveSweepDeps = (config: CloudinaryConfig, prefix: string): SweepDeps => ({
  list: () => listImages(prefix, config),
  referenced: () => referencedFromDatabase(config.cloudName),
  remove: (ids) => deleteImages(ids, config),
});
