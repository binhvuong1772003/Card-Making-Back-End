import type { Card } from '@prisma/client';
import { prisma } from '../../infra/prisma';
import { roleOf, type CardAccessRole } from './cards.access';
import type { CreateCardInput } from './cards.schema';

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

function toCardView(card: Card, actor: string): CardView {
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
  });
  return toCardView(card, actor);
}
