import type { Request, Response } from 'express';
import { getPublicPage } from './publications.service';

// Trang công khai thay đổi khi chủ thiệp xuất bản lại, nên chỉ cache ngắn; trình duyệt và CDN vẫn dùng được bản cũ trong lúc làm mới.
export async function getPage(req: Request, res: Response): Promise<void> {
  const page = await getPublicPage(String(req.params.slug));
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
  res.json(page);
}
