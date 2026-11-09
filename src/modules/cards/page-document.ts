import { builtInRegistry, isImageUrl, migratePage, validatePage, type PageData, type TreeNode } from '@miditor/core';
import { AppError } from '../../shared/errors';
import { cardComponents, retiredProps } from './components';
import { normalizeFormIds } from './responses/form-id';
import { upgradeLegacyForms } from './responses/legacy';

// Dữ liệu trang đến từ ngoài (trình duyệt) nên không bao giờ được tin cho tới khi qua đây: `migratePage` (đúng hình dạng, đúng phiên
// bản, id không trùng, giá trị an toàn để vẽ) rồi `validatePage` (các loại khối có trong registry, thuộc tính đúng quy tắc).
// Registry là các khối có sẵn của Miditor cộng khối riêng của CardMaking (`components.ts`).
const registry = { ...builtInRegistry, ...cardComponents };

// Bỏ các thuộc tính mà loại khối đó không còn (xem `retiredProps`): thiệp lưu từ trước vẫn mở và lưu được, chỉ mất phần khung riêng cũ
// (nay là nhóm Nền, Viền của Miditor). Trả bản mới, không đổi bản vào; nút không có gì để bỏ thì giữ nguyên đối tượng.
function withoutRetiredProps(node: TreeNode): TreeNode {
  const drop = Object.hasOwn(retiredProps, node.type) ? retiredProps[node.type]! : [];
  const props = drop.some((key) => Object.hasOwn(node.props, key))
    ? Object.fromEntries(Object.entries(node.props).filter(([key]) => !drop.includes(key)))
    : node.props;
  const children = node.children.map(withoutRetiredProps);
  return props === node.props && children.every((child, index) => child === node.children[index]) ? node : { ...node, props, children };
}
// Trường `custom` kiểu `single-image` (khối Khung ảnh) giữ một địa chỉ ảnh mà Miditor không kiểm: phải là địa chỉ ảnh hợp lệ hoặc rỗng.
// Trả số giá trị sai trong cây.
function badSingleImages(node: TreeNode): number {
  const def = Object.hasOwn(registry, node.type) ? registry[node.type] : undefined;
  let bad = 0;
  for (const [name, field] of Object.entries(def?.fields ?? {})) {
    if (field.type !== 'custom' || field.kind !== 'single-image') continue;
    const value = node.props[name];
    if (value !== undefined && value !== '' && !isImageUrl(value)) bad += 1;
  }
  return node.children.reduce((sum, child) => sum + badSingleImages(child), bad);
}

export const MAX_DOCUMENT_BYTES = 800 * 1024; // dưới giới hạn 1 MB của thân yêu cầu, chừa chỗ cho phần bao ngoài

// Trả trang đã đưa về phiên bản hiện tại (trang cũ được nâng cấp), hoặc ném VALIDATION. Thông điệp lỗi chỉ nói lý do chung,
// không chép lại dữ liệu người dùng gửi.
export function parsePageDocument(input: unknown, options: { normalizeDuplicateForms?: boolean } = {}): PageData {
  const size = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8');
  if (size > MAX_DOCUMENT_BYTES) throw new AppError('VALIDATION', 'The page is too large');
  const opened = migratePage(input);
  if (!opened.ok) throw new AppError('VALIDATION', `The page is not valid (${opened.reason})`);
  let root = withoutRetiredProps(upgradeLegacyForms(opened.page.root));
  if (options.normalizeDuplicateForms !== false) root = normalizeFormIds(root);
  const page = { ...opened.page, root };
  const problems = validatePage(registry, page).length + badSingleImages(page.root);
  if (problems > 0) throw new AppError('VALIDATION', `The page is not valid (${problems} problem${problems === 1 ? '' : 's'})`);
  return page;
}
