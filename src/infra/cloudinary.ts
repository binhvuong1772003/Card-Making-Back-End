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
