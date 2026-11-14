import { builtInRegistry, isColorValue, isImageUrl, migratePage, SHAPE_NAMES, validatePage, type PageData, type Registry, type TreeNode } from '@miditor/core';
import { AppError } from '../../shared/errors';
import { cardComponents, retiredProps } from './components';
import { normalizeFormIds } from './responses/form-id';
import { upgradeLegacyForms } from './responses/legacy';
import photoFrameCatalog from './photo-frame-catalog.json';

// Dữ liệu trang đến từ ngoài (trình duyệt) nên không bao giờ được tin cho tới khi qua đây: `migratePage` (đúng hình dạng, đúng phiên
// bản, id không trùng, giá trị an toàn để vẽ) rồi `validatePage` (các loại khối có trong registry, thuộc tính đúng quy tắc).
// Registry là các khối có sẵn của Miditor cộng khối riêng của CardMaking (`components.ts`).
const registry: Registry = {
  ...builtInRegistry,
  ...cardComponents,
  // Image lấy từ danh sách của CardMaking (có thêm ô "Khi mở thiệp") nếu có, rồi thêm tham chiếu kho trang trí `cmAssetId`.
  Image: { ...(cardComponents.Image ?? builtInRegistry.Image), fields: { ...(cardComponents.Image ?? builtInRegistry.Image).fields, cmAssetId: { type: 'text' as const, label: '', maxLength: 24, hidden: true } } },
};
const legacyFrameShapes = new Map(photoFrameCatalog.map(({ id, legacyType }) => [legacyType, id]));
const legacyDressCodeColors = ['#8d9d70', '#e7e8e9', '#e8dec6'] as const;

function upgradeLegacyDressCodeColors(node: TreeNode): TreeNode {
  const children = node.children.map(upgradeLegacyDressCodeColors);
  if (node.type !== 'DressCode') return children.every((child, index) => child === node.children[index]) ? node : { ...node, children };
  const props = { ...node.props };
  if (!Array.isArray(props.colors)) {
    props.colors = ['swatch1', 'swatch2', 'swatch3'].map((key, index) => isColorValue(props[key]) ? props[key] : legacyDressCodeColors[index]);
  }
  const sameProps = Object.keys(props).length === Object.keys(node.props).length && Object.entries(props).every(([key, value]) => node.props[key] === value);
  return sameProps && children.every((child, index) => child === node.children[index]) ? node : { ...node, props, children };
}

function upgradeLegacyPhotoFrames(node: TreeNode): TreeNode {
  const legacyShape = legacyFrameShapes.get(node.type);
  const isFrame = legacyShape !== undefined || node.type === 'PhotoFrame';
  const rawShape = node.props.shape;
  const rawId = typeof rawShape === 'object' && rawShape !== null && !Array.isArray(rawShape) && typeof rawShape.id === 'string'
    ? rawShape.id : typeof rawShape === 'string' ? rawShape : undefined;
  const catalogShape = photoFrameCatalog.find((item) => item.id === (rawId ?? legacyShape));
  const shape = typeof rawShape === 'object' && rawShape !== null && !Array.isArray(rawShape) ? rawShape
    : { id: catalogShape?.id ?? legacyShape ?? 'rectangle', geometry: catalogShape?.geometry ?? 'rectangle', maskPath: catalogShape?.maskPath ?? '' };
  const props = isFrame ? { ...node.props, shape } : node.props;
  const children = node.children.map(upgradeLegacyPhotoFrames);
  if (!legacyShape && props === node.props && children.every((child, index) => child === node.children[index])) return node;
  return { ...node, ...(legacyShape ? { type: 'PhotoFrame' } : {}), props, children };
}

function badPhotoFrameShapes(node: TreeNode): number {
  const shape = node.props.shape;
  const shapeObject = typeof shape === 'object' && shape !== null && !Array.isArray(shape) ? shape : null;
  const geometry = shapeObject?.geometry;
  const maskPath = shapeObject?.maskPath;
  const validPath = typeof maskPath === 'string' && maskPath.length <= 4000 && /^[MmLlHhVvCcSsQqTtAaZz0-9+.,\-\s]*$/.test(maskPath);
  const validGeometry = typeof geometry === 'string' && (geometry === 'custom' ? validPath && maskPath.length > 0 : (SHAPE_NAMES as readonly string[]).includes(geometry));
  const invalidShape = node.type === 'PhotoFrame' && (!shapeObject || typeof shapeObject.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(shapeObject.id) || !validGeometry) ? 1 : 0;
  return invalidShape + node.children.reduce((sum, child) => sum + badPhotoFrameShapes(child), 0);
}

function badDecorativeAssetRefs(node: TreeNode): number {
  const id = node.type === 'Image' ? node.props.cmAssetId : undefined;
  const invalid = id !== undefined && (typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id)) ? 1 : 0;
  return invalid + node.children.reduce((sum, child) => sum + badDecorativeAssetRefs(child), 0);
}

function badTextEffects(node: TreeNode): number {
  const value = node.type === 'Text' ? node.props.effects : undefined;
  if (value === undefined) return node.children.reduce((sum, child) => sum + badTextEffects(child), 0);
  if (!Array.isArray(value) || value.length > 10) return 1 + node.children.reduce((sum, child) => sum + badTextEffects(child), 0);
  const ids = new Set<string>();
  const types = new Set<string>();
  const invalid = value.some((effect) => {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return true;
    const item = effect as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'amount,id,type' || item.type !== 'curve' || typeof item.id !== 'string' || !/^[\w-]{1,40}$/.test(item.id) || ids.has(item.id) || types.has(item.type) || typeof item.amount !== 'number' || !Number.isInteger(item.amount) || item.amount < -100 || item.amount > 100) return true;
    ids.add(item.id);
    types.add(item.type);
    return false;
  }) ? 1 : 0;
  return invalid + node.children.reduce((sum, child) => sum + badTextEffects(child), 0);
}

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
  let root = withoutRetiredProps(upgradeLegacyDressCodeColors(upgradeLegacyPhotoFrames(upgradeLegacyForms(opened.page.root))));
  if (options.normalizeDuplicateForms !== false) root = normalizeFormIds(root);
  const page = { ...opened.page, root };
  const problems = validatePage(registry, page).length + badSingleImages(page.root) + badPhotoFrameShapes(page.root) + badDecorativeAssetRefs(page.root) + badTextEffects(page.root);
  if (problems > 0) throw new AppError('VALIDATION', `The page is not valid (${problems} problem${problems === 1 ? '' : 's'})`);
  return page;
}
