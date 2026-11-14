import { signParams, type CloudinaryConfig } from '../../infra/cloudinary';
import { AppError } from '../../shared/errors';

export type { CloudinaryConfig };

export interface UploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  allowedFormats: string;
  transformation: string;
  signature: string;
}

// Định dạng được phép, ký cùng yêu cầu để người dùng không đổi được sang loại file khác.
const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,gif,avif';
// Biến đổi áp NGAY khi ảnh vào kho (được ký nên không bỏ được): ảnh lớn hơn 4000 px bị thu nhỏ vừa khung 4000 x 4000, giữ tỉ lệ.
const INCOMING_TRANSFORMATION = 'c_limit,h_4000,w_4000';

// Chữ ký tải thẳng lên Cloudinary: SHA-1 của các tham số đã ký, sắp theo tên và nối bằng `&`, cộng api secret
// (https://cloudinary.com/documentation/authentication_signatures). Mỗi người dùng một thư mục riêng; chữ ký chỉ có hiệu lực ngắn.
export function signUpload(actor: string, config: CloudinaryConfig | null, now: number = Date.now()): UploadSignature {
  if (!config) throw new AppError('PROVIDER_UNAVAILABLE', 'Image storage is not configured');
  const timestamp = Math.floor(now / 1000);
  const folder = `cardmaking/${actor}`;
  const signature = signParams({ allowed_formats: ALLOWED_FORMATS, folder, timestamp, transformation: INCOMING_TRANSFORMATION }, config.apiSecret);
  return { cloudName: config.cloudName, apiKey: config.apiKey, timestamp, folder, allowedFormats: ALLOWED_FORMATS, transformation: INCOMING_TRANSFORMATION, signature };
}

export function signCatalogUpload(config: CloudinaryConfig | null, now: number = Date.now()): UploadSignature {
  if (!config) throw new AppError('PROVIDER_UNAVAILABLE', 'Image storage is not configured');
  const timestamp = Math.floor(now / 1000);
  const folder = 'cardmaking/decorations';
  const allowedFormats = 'png,jpg,jpeg,webp,svg';
  const transformation = 'c_limit,h_3000,w_3000';
  const signature = signParams({ allowed_formats: allowedFormats, folder, timestamp, transformation }, config.apiSecret);
  return { cloudName: config.cloudName, apiKey: config.apiKey, timestamp, folder, allowedFormats, transformation, signature };
}
