import { createHash } from 'node:crypto';
import { AppError } from '../shared/errors';

export interface CloudinaryConfig {
  apiKey: string;
  apiSecret: string;
  cloudName: string;
}

// Chữ ký của Cloudinary: SHA-1 của các tham số đã ký, sắp theo tên và nối bằng `&`, cộng api secret
// (https://cloudinary.com/documentation/authentication_signatures). `file`, `api_key`, `signature` không nằm trong phần được ký.
export function signParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}

// Nhờ Cloudinary tự tải một ảnh (theo địa chỉ) vào thư mục `folder` của kho, rồi trả địa chỉ mới. Chạy phía backend vì cần api secret.
// `public_id` suy từ địa chỉ gốc và không ghi đè, nên làm lại cùng một ảnh (thử lại sau lỗi) không tạo bản trùng.
export async function copyImage(
  url: string,
  folder: string,
  config: CloudinaryConfig,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<string> {
  const publicId = createHash('sha1').update(url).digest('hex').slice(0, 20);
  const timestamp = Math.floor(now / 1000);
  const signed = { folder, overwrite: 'false', public_id: publicId, timestamp };
  const body = new URLSearchParams({ file: url, api_key: config.apiKey, signature: signParams(signed, config.apiSecret), ...Object.fromEntries(Object.entries(signed).map(([k, v]) => [k, String(v)])) });
  try {
    const res = await fetchImpl(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, { method: 'POST', body });
    if (!res.ok) throw new Error(`Cloudinary answered ${res.status}`);
    const data = (await res.json()) as { secure_url?: unknown };
    if (typeof data.secure_url !== 'string') throw new Error('Cloudinary gave no address');
    return data.secure_url;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('PROVIDER_FAILED', 'Could not copy an image to the template folder');
  }
}

// ---- Admin API: liệt kê và xoá ảnh trong kho (dùng cho job dọn ảnh). Xác thực bằng Basic (api key và secret trong header, không nằm trong địa chỉ). ----

export interface ImageResource {
  publicId: string;
  createdAt: string;
}

const adminHeaders = (config: CloudinaryConfig): Record<string, string> => ({
  Authorization: `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64')}`,
});

// Mọi ảnh có public_id bắt đầu bằng `prefix`, đi qua từng trang (500 ảnh một trang).
export async function listImages(prefix: string, config: CloudinaryConfig, fetchImpl: typeof fetch = fetch): Promise<ImageResource[]> {
  const found: ImageResource[] = [];
  let cursor: string | undefined;
  try {
    do {
      const query = new URLSearchParams({ prefix, max_results: '500', ...(cursor ? { next_cursor: cursor } : {}) });
      const res = await fetchImpl(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/image/upload?${query}`, { headers: adminHeaders(config) });
      if (!res.ok) throw new Error(`Cloudinary answered ${res.status}`);
      const data = (await res.json()) as { resources?: { public_id: string; created_at: string }[]; next_cursor?: string };
      for (const item of data.resources ?? []) found.push({ publicId: item.public_id, createdAt: item.created_at });
      cursor = data.next_cursor;
    } while (cursor);
  } catch {
    throw new AppError('PROVIDER_FAILED', 'Could not list the images');
  }
  return found;
}

// Xoá ảnh theo lô 100 (giới hạn của Cloudinary). Trả số ảnh Cloudinary báo đã xoá.
export async function deleteImages(publicIds: readonly string[], config: CloudinaryConfig, fetchImpl: typeof fetch = fetch): Promise<number> {
  let deleted = 0;
  try {
    for (let i = 0; i < publicIds.length; i += 100) {
      const body = new URLSearchParams();
      for (const id of publicIds.slice(i, i + 100)) body.append('public_ids[]', id);
      const res = await fetchImpl(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/image/upload`, { method: 'DELETE', headers: adminHeaders(config), body });
      if (!res.ok) throw new Error(`Cloudinary answered ${res.status}`);
      const data = (await res.json()) as { deleted?: Record<string, string> };
      deleted += Object.values(data.deleted ?? {}).filter((state) => state === 'deleted').length;
    }
  } catch {
    throw new AppError('PROVIDER_FAILED', 'Could not delete the images');
  }
  return deleted;
}
