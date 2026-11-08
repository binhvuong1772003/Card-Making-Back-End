// Cấu hình của khối form lấy từ BẢN ĐÃ XUẤT BẢN của thiệp (Publication.document), không từ khách: khách không giả được hạn hay việc có
// duyệt trước. Tên loại khối và tên thuộc tính là hợp đồng với frontend (`CMFE/lib/cards/blocks`): đổi bên nào phải đổi bên kia.
export const FORM_BLOCK = 'Form';

export interface BlockNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: BlockNode[];
}

// Tìm khối theo mã trong cây của trang. Dữ liệu từ bản xuất bản đã qua kiểm khi xuất bản nên hình dạng đúng, nhưng vẫn không giả định gì thêm.
export function findBlock(root: unknown, blockId: string): BlockNode | undefined {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Partial<BlockNode> | null | undefined;
    if (!node || typeof node !== 'object') continue;
    if (node.id === blockId && typeof node.type === 'string') return { id: node.id, type: node.type, props: (node.props as Record<string, unknown>) ?? {}, children: node.children };
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return undefined;
}

// Các khối `Form` của trang, theo đúng thứ tự chúng nằm trong cây (thứ tự này là thứ tự tab trong trang Phản hồi).
export function collectFormBlocks(root: unknown): BlockNode[] {
  const found: BlockNode[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const block = node as Partial<BlockNode>;
    if (typeof block.id === 'string' && typeof block.type === 'string' && block.type === FORM_BLOCK) {
      found.push({ id: block.id, type: block.type, props: (block.props as Record<string, unknown>) ?? {}, children: block.children });
    }
    if (Array.isArray(block.children)) for (const child of block.children) walk(child);
  };
  walk(root);
  return found;
}
