import type { TreeNode } from '@miditor/core';

// Khoá gắn phản hồi với một form: `props.formId` (sinh ngẫu nhiên lúc thêm form), không có thì dùng id của nút.
// Chỉ dùng id của nút thì không đủ: Miditor luôn cấp lại id trống nhỏ nhất, nên xoá một form rồi thêm form mới sẽ trùng khoá
// và phản hồi của form cũ dính sang form mới.
export const FORM_TYPE = 'Form';
const FORM_ID = /^[A-Za-z0-9_-]{1,40}$/;

// Khoá của một form: `formId` hợp lệ, không thì id của nút (trang từ trước khi có `formId`: phản hồi của chúng vẫn gắn đúng).
export function formKeyOf(props: Record<string, unknown> | undefined, nodeId: string): string {
  const value = props?.formId;
  return typeof value === 'string' && FORM_ID.test(value) ? value : nodeId;
}

// Hai form không bao giờ được chung khoá (Nhân đôi chép cả thuộc tính, gồm `formId`). Form thứ hai nhận khoá suy ra từ id nút của nó,
// cố định để giữ nguyên giữa các lần lưu. Không có gì đổi thì trả đúng cây cũ.
export function normalizeFormIds(root: TreeNode): TreeNode {
  const seen = new Set<string>();
  const walk = (node: TreeNode): TreeNode => {
    let next = node;
    if (node.type === FORM_TYPE) {
      const key = formKeyOf(node.props, node.id);
      if (!seen.has(key)) seen.add(key);
      else {
        let fresh = `${key.slice(0, Math.max(1, 40 - node.id.length - 1))}_${node.id}`.slice(0, 40);
        for (let n = 2; seen.has(fresh); n++) fresh = `${fresh.slice(0, 36)}_${n}`;
        seen.add(fresh);
        next = { ...node, props: { ...node.props, formId: fresh } };
      }
    }
    const children = next.children.map(walk);
    return children.every((child, index) => child === next.children[index]) ? next : { ...next, children };
  };
  return walk(root);
}
