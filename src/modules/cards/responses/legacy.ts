import type { JsonValue, TreeNode } from '@miditor/core';
import type { Field } from './form-fields';

// Thiệp lưu hoặc đã xuất bản trước khi có khối `Form` còn khối `Rsvp` / `Guestbook`. Đổi chúng thành `Form` với đúng các ô của
// mẫu dựng sẵn tương ứng (id ô cố định, khớp `CMFE/lib/cards/blocks/form-presets.ts`), giữ nguyên id, chỗ đứng, kích thước và kiểu
// của khối. Hàm thuần, khoan dung: thiếu thuộc tính thì dùng mặc định cũ của khối.
const RSVP = 'Rsvp';
const GUESTBOOK = 'Guestbook';
const FORM = 'Form';

const ATTEND = 'Có, tôi sẽ đến';
const MAYBE = 'Chưa chắc';

const text = (props: Record<string, JsonValue>, key: string, fallback: string): string =>
  typeof props[key] === 'string' ? (props[key] as string) : fallback;

const flag = (props: Record<string, JsonValue>, key: string, fallback: boolean): boolean =>
  typeof props[key] === 'boolean' ? (props[key] as boolean) : fallback;

const whole = (props: Record<string, JsonValue>, key: string, fallback: number, min: number, max: number): number => {
  const value = props[key];
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
};

// `askPhone` của khối cũ chỉ hỏi khi khách chọn Có hoặc Chưa chắc; `showIf` chỉ so được một đáp án nên ô điện thoại hiện luôn.
function attendanceFields(props: Record<string, JsonValue>): Field[] {
  const options = [ATTEND, 'Rất tiếc, không đến được'];
  if (flag(props, 'askMaybe', true)) options.push(MAYBE);
  const fields: Field[] = [
    { id: 'name', type: 'text', label: 'Họ và tên', required: true },
    { id: 'attending', type: 'choice', label: 'Bạn sẽ đến chứ?', required: true, options },
  ];
  if (flag(props, 'askGuests', true)) {
    fields.push({
      id: 'guests',
      type: 'number',
      label: 'Số khách (tính cả bạn)',
      required: true,
      min: 1,
      max: whole(props, 'maxGuests', 4, 1, 1_000_000),
      showIf: { fieldId: 'attending', equals: ATTEND },
    });
  }
  if (flag(props, 'askPhone', false)) fields.push({ id: 'phone', type: 'phone', label: 'Số điện thoại', required: false });
  if (flag(props, 'askNote', true)) fields.push({ id: 'note', type: 'longtext', label: 'Lời nhắn', required: false });
  return fields;
}

// Ô chung của khối cũ mà form mới cũng có, giữ nguyên giá trị chủ thiệp đã đặt.
const keepLook = (props: Record<string, JsonValue>, heading: string, button: string) => ({
  heading: text(props, 'heading', heading),
  intro: text(props, 'intro', ''),
  button: text(props, 'button', button),
  color: text(props, 'color', '#511419'),
  padding: whole(props, 'padding', 16, 0, 40),
});

function upgradedProps(props: Record<string, JsonValue>): Record<string, JsonValue> {
  if (props === null || typeof props !== 'object') return {};
  return props;
}

function rsvpProps(raw: Record<string, JsonValue>): Record<string, JsonValue> {
  const props = upgradedProps(raw);
  return {
    ...keepLook(props, 'Bạn sẽ đến chứ?', 'Gửi xác nhận'),
    success: 'Cảm ơn bạn, chúng mình đã nhận được xác nhận.',
    deadline: text(props, 'deadline', ''),
    fields: attendanceFields(props) as unknown as JsonValue,
    publicList: { enabled: false, nameFieldId: '', textFieldId: '' },
    moderation: false,
  };
}

function guestbookProps(raw: Record<string, JsonValue>): Record<string, JsonValue> {
  const props = upgradedProps(raw);
  return {
    ...keepLook(props, 'Sổ lưu bút', 'Gửi lời chúc'),
    success: 'Cảm ơn bạn. Lời chúc đã hiện trong sổ.',
    deadline: '',
    fields: [
      { id: 'name', type: 'text', label: 'Tên của bạn', required: true },
      { id: 'message', type: 'longtext', label: 'Lời chúc', required: true },
    ] as unknown as JsonValue,
    publicList: { enabled: true, nameFieldId: 'name', textFieldId: 'message' },
    moderation: flag(props, 'moderation', false),
  };
}

export function upgradeLegacyForms(root: TreeNode): TreeNode {
  return upgradeNode(root);
}

// Trả lại chính đối tượng khi không có gì đổi, để trang không có khối cũ không bị chép lại.
function upgradeNode(node: TreeNode): TreeNode {
  const children = node.children.map(upgradeNode);
  const childrenChanged = children.some((child, index) => child !== node.children[index]);
  const props = node.type === RSVP ? rsvpProps(node.props) : node.type === GUESTBOOK ? guestbookProps(node.props) : null;
  if (!props) return childrenChanged ? { ...node, children } : node;
  return { ...node, type: FORM, props, children };
}
