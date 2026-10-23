export type CardAccessRole = 'OWNER' | 'EDITOR' | 'VIEWER';

interface CardAccessFields {
  ownerId: string;
  members: { userId: string; role: 'EDITOR' | 'VIEWER' }[];
}

// Vai trò của user trên thiệp, hoặc null nếu không liên quan. Chủ sở hữu nằm ở ownerId, không có trong members.
export function roleOf(card: CardAccessFields, userId: string): CardAccessRole | null {
  if (card.ownerId === userId) return 'OWNER';
  return card.members.find((member) => member.userId === userId)?.role ?? null;
}
