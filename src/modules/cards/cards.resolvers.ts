import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../graphql/context';
import { requireUser } from '../../graphql/guards';
import { createCardInput, listCardsArgs, parseCardId, updateCardTitleInput } from './cards.schema';
import * as cardsService from './cards.service';

// Resolver chỉ làm thủ tục: đăng nhập, kiểm đầu vào, gọi service. Các trường của Card tự lấy từ object service trả về.
const resolvers = {
  Query: {
    cards: (_parent: unknown, args: { first?: number | null; after?: string | null; occasion?: string | null; search?: string | null }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      // Giá trị null tường minh từ client được coi như không truyền.
      return cardsService.listCards(actor, listCardsArgs.parse({ first: args.first ?? undefined, after: args.after ?? undefined, occasion: args.occasion ?? undefined, search: args.search ?? undefined }));
    },

    card: (_parent: unknown, args: { id: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return cardsService.getCard(actor, parseCardId(args.id));
    },
  },

  Mutation: {
    createCard: (_parent: unknown, args: { input: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return cardsService.createCard(actor, createCardInput.parse(args.input));
    },

    duplicateCard: (_parent: unknown, args: { id: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return cardsService.duplicateCard(actor, parseCardId(args.id));
    },

    updateCardTitle: (_parent: unknown, args: { id: unknown; title: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return cardsService.updateCardTitle(actor, parseCardId(args.id), updateCardTitleInput.parse({ title: args.title }));
    },

    saveCardDocument: (_parent: unknown, args: { id: unknown; revision: number; document: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return cardsService.saveCardDocument(actor, parseCardId(args.id), args.revision, args.document);
    },

    deleteCard: async (_parent: unknown, args: { id: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      await cardsService.deleteCard(actor, parseCardId(args.id));
      return true;
    },
  },
};

// Object thuần { typeDefs, resolvers }: app.ts đưa vào createGraphql (cards không import kiểu từ graphql/create-graphql).
export const cardsModule = {
  typeDefs: readFileSync(join(__dirname, 'cards.graphql'), 'utf8'),
  resolvers,
};
