import { builtInRegistry, migratePage, validatePage, type PageData } from '@miditor/core';
import { AppError } from '../../shared/errors';

// Dữ liệu trang đến từ ngoài (trình duyệt) nên không bao giờ được tin cho tới khi qua đây: `migratePage` (đúng hình dạng, đúng phiên
// bản, id không trùng, giá trị an toàn để vẽ) rồi `validatePage` (các loại khối có trong registry, thuộc tính đúng quy tắc).
// CardMaking chưa có khối riêng nên dùng registry có sẵn của Miditor; có khối riêng thì đưa registry của mình vào đây.
export const MAX_DOCUMENT_BYTES = 800 * 1024; // dưới giới hạn 1 MB của thân yêu cầu, chừa chỗ cho phần bao ngoài

// Trả trang đã đưa về phiên bản hiện tại (trang cũ được nâng cấp), hoặc ném VALIDATION. Thông điệp lỗi chỉ nói lý do chung,
// không chép lại dữ liệu người dùng gửi.
export function parsePageDocument(input: unknown): PageData {
  const size = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8');
  if (size > MAX_DOCUMENT_BYTES) throw new AppError('VALIDATION', 'The page is too large');
  const opened = migratePage(input);
  if (!opened.ok) throw new AppError('VALIDATION', `The page is not valid (${opened.reason})`);
  const issues = validatePage(builtInRegistry, opened.page);
  if (issues.length > 0) throw new AppError('VALIDATION', `The page is not valid (${issues.length} problem${issues.length === 1 ? '' : 's'})`);
  return opened.page;
}
