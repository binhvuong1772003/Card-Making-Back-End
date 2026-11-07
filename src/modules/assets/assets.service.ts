import { signParams, type CloudinaryConfig } from '../../infra/cloudinary';
import { AppError } from '../../shared/errors';

export type { CloudinaryConfig };

export interface UploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  allowedFormats: string;
  signature: string;
}

// Định dạng được phép, ký cùng yêu cầu để người dùng không đổi được sang loại file khác.
const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,gif,avif';

// Chữ ký tải thẳng lên Cloudinary: SHA-1 của các tham số đã ký, sắp theo tên và nối bằng `&`, cộng api secret
// (https://cloudinary.com/documentation/authentication_signatures). Mỗi người dùng một thư mục riêng; chữ ký chỉ có hiệu lực ngắn.
export function signUpload(actor: string, config: CloudinaryConfig | null, now: number = Date.now()): UploadSignature {
  if (!config) throw new AppError('PROVIDER_UNAVAILABLE', 'Image storage is not configured');
  const timestamp = Math.floor(now / 1000);
  const folder = `cardmaking/${actor}`;
  const signature = signParams({ allowed_formats: ALLOWED_FORMATS, folder, timestamp }, config.apiSecret);
  return { cloudName: config.cloudName, apiKey: config.apiKey, timestamp, folder, allowedFormats: ALLOWED_FORMATS, signature };
}
