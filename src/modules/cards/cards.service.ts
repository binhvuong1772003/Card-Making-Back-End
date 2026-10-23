import { Prisma, type Card } from '@prisma/client';
import { prisma } from '../../infra/prisma';
import { AppError } from '../../shared/errors';
import { can, roleOf, type CardAccessRole, type CardAction } from './cards.access';
import type { CreateCardInput, UpdateCardTitleInput } from './cards.schema';

// Hình dạng trả cho tầng giao tiếp: không có document (cấu trúc nội dung chưa chốt nên chưa đưa ra API).
export interface CardView {
  id: string;
  title: string;
  revision: number;
  role: CardAccessRole;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

type CardRow = Pick<Card, 'id' | 'title' | 'revision' | 'ownerId' | 'members' | 'createdAt' | 'updatedAt'>;

function toCardView(card: CardRow, actor: string): CardView {
  const role = roleOf(card, actor);
  if (!role) throw new Error('actor has no role on the card'); // không xảy ra: gọi sau khi chắc chắn có quyền
  return {
    id: card.id,
    title: card.title,
    revision: card.revision,
    role,
    ownerId: card.ownerId,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

const isWriteConflict = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

// Đọc vai trò và kiểm quyền. Người không liên quan nhận NOT_FOUND (không lộ thiệp có tồn tại), người có vai trò nhưng
// không đủ quyền nhận FORBIDDEN. Không tải document (nặng và không cần để kiểm quyền).
async function requireAccess(actor: string, id: string, action: CardAction): Promise<void> {
  const card = await prisma.card.findUnique({ where: { id }, select: { ownerId: true, members: true } });
  const role = card && roleOf(card, actor);
  if (!card || !role) throw new AppError('NOT_FOUND', 'Card not found');
  if (!can(role, action)) throw new AppError('FORBIDDEN', 'You do not have permission to do that');
}

// `actor` là userId của người gọi. Service không biết req, res hay GraphQL.
export async function createCard(actor: string, input: CreateCardInput): Promise<CardView> {
  const card = await prisma.card.create({
    data: {
      ownerId: actor,
      title: input.title,
      document: {}, // giữ chỗ: cấu trúc nội dung thiệp chưa chốt
      revision: 0,
      members: [], // tường minh: bỏ trống thì Prisma không ghi trường này và các bộ lọc none/isEmpty/NOT some không khớp
    },
    omit: { document: true },
  });
  return toCardView(card, actor);
}

// Chỉ đổi tiêu đề: không đụng document hay revision (bản nháp chỉ đổi qua applyOps). updatedAt tự tăng.
export async function updateCardTitle(actor: string, id: string, input: UpdateCardTitleInput): Promise<CardView> {
  for (let attempt = 0; ; attempt++) {
    await requireAccess(actor, id, 'rename');
    try {
      // Lặp lại điều kiện quyền ngay trong lệnh ghi: vai trò bị hạ hoặc thiệp bị xóa giữa lúc kiểm và lúc ghi thì không ghi.
      const card = await prisma.card.update({
        where: { id, OR: [{ ownerId: actor }, { members: { some: { userId: actor, role: 'EDITOR' } } }] },
        data: { title: input.title },
        omit: { document: true },
      });
      return toCardView(card, actor);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new AppError('NOT_FOUND', 'Card not found');
      }
      // Đổi tên đụng độ với xóa hoặc một lần đổi tên khác: thử lại một lần (lúc đó requireAccess thấy thiệp đã mất thì NOT_FOUND).
      if (attempt >= 1 || !isWriteConflict(err)) throw err;
    }
  }
}

// Xóa thiệp cùng publication và link mời trong một transaction (Prisma trên Mongo không xóa dây chuyền, và Restrict còn
// chặn xóa thiệp khi con còn tồn tại). Mẫu đã đăng từ thiệp này không bị ảnh hưởng.
export async function deleteCard(actor: string, id: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await requireAccess(actor, id, 'delete');
    try {
      await prisma.$transaction(async (tx) => {
        await tx.publication.deleteMany({ where: { cardId: id } });
        await tx.cardInvite.deleteMany({ where: { cardId: id } });
        const deleted = await tx.card.deleteMany({ where: { id, ownerId: actor } });
        if (deleted.count === 0) throw new AppError('NOT_FOUND', 'Card not found'); // hoàn tác cả transaction
      });
      return;
    } catch (err) {
      // Hai lần xóa đồng thời: bên thua có thể nhận xung đột ghi. Thử lại một lần; lúc đó thiệp đã mất nên requireAccess
      // trả NOT_FOUND.
      if (attempt >= 1 || !isWriteConflict(err)) throw err;
    }
  }
}
