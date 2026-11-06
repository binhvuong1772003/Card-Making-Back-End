export type CardAccessRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export type CardAction = 'view' | 'rename' | 'edit' | 'delete';

interface CardAccessFields {
  ownerId: string;
  members: { userId: string; role: 'EDITOR' | 'VIEWER' }[];
}

// Vai trò của user trên thiệp, hoặc null nếu không liên quan. Chủ sở hữu nằm ở ownerId, không có trong members.
export function roleOf(card: CardAccessFields, userId: string): CardAccessRole | null {
  if (card.ownerId === userId) return 'OWNER';
  return card.members.find((member) => member.userId === userId)?.role ?? null;
}

const ALLOWED: Record<CardAction, readonly CardAccessRole[]> = {
  view: ['OWNER', 'EDITOR', 'VIEWER'],
  rename: ['OWNER', 'EDITOR'],
  edit: ['OWNER', 'EDITOR'],
  delete: ['OWNER'],
};

// Bảng quyền duy nhất của thiệp: mọi thao tác hỏi ở đây thay vì tự so sánh vai trò.
export const can = (role: CardAccessRole, action: CardAction): boolean => ALLOWED[action].includes(role);
