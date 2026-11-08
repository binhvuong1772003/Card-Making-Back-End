// Cấu hình của khối form lấy từ BẢN ĐÃ XUẤT BẢN của thiệp (Publication.document), không từ khách: khách không giả được hạn hay việc có
// duyệt trước. Tên loại khối và tên thuộc tính là hợp đồng với frontend (`CMFE/lib/cards/blocks`): đổi bên nào phải đổi bên kia.
import { formKeyOf, FORM_TYPE } from './form-id';

export const FORM_BLOCK = FORM_TYPE;

export interface BlockNode {
  id: string;
  /** Clé des réponses de ce formulaire (`formId`, ou l'id du nœud à défaut), voir `form-id.ts`. */
  key: string;
  type: string;
  props: Record<string, unknown>;
  children?: BlockNode[];
}

// Tìm khối Form theo khoá của nó (`formId`, hoặc id nút với trang cũ chưa có `formId`). Dữ liệu từ bản xuất bản đã qua kiểm khi xuất bản
// nên hình dạng đúng, nhưng vẫn không giả định gì thêm. Nếu hai khối trùng khoá (bản cũ), lấy khối đứng trước.
export function findFormBlock(root: unknown, key: string): BlockNode | undefined {
  return collectFormBlocks(root).find((block) => block.key === key);
}

// Các khối `Form` của trang, theo đúng thứ tự chúng nằm trong cây (thứ tự này là thứ tự tab trong trang Phản hồi).
export function collectFormBlocks(root: unknown): BlockNode[] {
  const found: BlockNode[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const block = node as Partial<BlockNode>;
    if (typeof block.id === 'string' && typeof block.type === 'string' && block.type === FORM_BLOCK) {
      const props = (block.props as Record<string, unknown>) ?? {};
      found.push({ id: block.id, key: formKeyOf(props, block.id), type: block.type, props, children: block.children });
    }
    if (Array.isArray(block.children)) for (const child of block.children) walk(child);
  };
  walk(root);
  return found;
}
