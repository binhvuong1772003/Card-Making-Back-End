// Cấu hình của khối form lấy từ BẢN ĐÃ XUẤT BẢN của thiệp (Publication.document), không từ khách: khách không giả được hạn, số khách tối đa hay
// việc có duyệt trước. Tên loại khối và tên thuộc tính là hợp đồng với frontend (`CMFE/lib/cards/blocks`): đổi bên nào phải đổi bên kia.
export const RSVP_BLOCK = 'Rsvp';
export const GUESTBOOK_BLOCK = 'Guestbook';

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

export const MAX_GUESTS_LIMIT = 20;

export interface RsvpConfig {
  /** Hạn xác nhận, "YYYY-MM-DD" (hết ngày đó theo giờ Việt Nam); null là không hạn. */
  deadline: string | null;
  maxGuests: number;
  askGuests: boolean;
  askNote: boolean;
  askPhone: boolean;
  askMaybe: boolean;
}

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

export function rsvpConfig(props: Record<string, unknown>): RsvpConfig {
  const max = typeof props.maxGuests === 'number' && Number.isFinite(props.maxGuests) ? Math.floor(props.maxGuests) : 4;
  return {
    deadline: typeof props.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(props.deadline) ? props.deadline : null,
    maxGuests: Math.min(MAX_GUESTS_LIMIT, Math.max(1, max)),
    askGuests: flag(props.askGuests, true),
    askNote: flag(props.askNote, true),
    askPhone: flag(props.askPhone, false),
    askMaybe: flag(props.askMaybe, true),
  };
}

export interface GuestbookConfig {
  /** Bật thì lời chúc mới ở trạng thái PENDING cho đến khi chủ thiệp duyệt. */
  moderation: boolean;
}

export const guestbookConfig = (props: Record<string, unknown>): GuestbookConfig => ({ moderation: flag(props.moderation, false) });

// Hết ngày hạn theo giờ Việt Nam (UTC+7): 23:59:59.999 ngày đó là 16:59:59.999 UTC. Ngày không có thật (30 tháng 2) coi như không có hạn.
export function isClosed(deadline: string | null, now: Date): boolean {
  if (!deadline) return false;
  const [year, month, day] = deadline.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return false;
  return now.getTime() > Date.UTC(year, month - 1, day, 16, 59, 59, 999);
}
