import type { RequestHandler } from 'express';
import { signUpload, type CloudinaryConfig } from './assets.service';

// Cấp chữ ký để trình duyệt tải ảnh thẳng lên Cloudinary. Chỉ trả những gì client cần; api secret ở lại backend.
export const createSignHandler =
  (config: CloudinaryConfig | null): RequestHandler =>
  (_req, res) => {
    res.json(signUpload(res.locals.auth!.userId, config));
  };
