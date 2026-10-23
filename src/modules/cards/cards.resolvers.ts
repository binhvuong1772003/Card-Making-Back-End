import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../graphql/context';
import { requireUser } from '../../graphql/guards';
import { createCardInput, parseCardId, updateCardTitleInput } from './cards.schema';
import * as cardsService from './cards.service';

// Resolver chỉ làm thủ tục: đăng nhập, kiểm đầu vào, gọi service. Các trường của Card tự lấy từ object service trả về.
const resolvers = {
  Mutation: {
    createCard: (_parent: unknown, args: { input: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return cardsService.createCard(actor, createCardInput.parse(args.input));
    },

    updateCardTitle: (_parent: unknown, args: { id: unknown; title: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return cardsService.updateCardTitle(actor, parseCardId(args.id), updateCardTitleInput.parse({ title: args.title }));
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
