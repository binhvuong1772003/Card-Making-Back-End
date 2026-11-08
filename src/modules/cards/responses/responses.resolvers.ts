import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../../graphql/context';
import { requireUser } from '../../../graphql/guards';
import { parseCardId } from '../cards.schema';
import { entryStatus, formResponsesArgs, parseRowId } from './responses.schema';
import * as responses from './responses.service';

const resolvers = {
  Query: {
    cardForms: (_parent: unknown, args: { cardId: unknown }, ctx: GraphqlContext) => responses.listCardForms(requireUser(ctx), parseCardId(args.cardId)),
    formResponses: (_parent: unknown, args: Record<string, unknown>, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      const { cardId, ...rest } = args;
      return responses.listFormResponses(actor, parseCardId(cardId), formResponsesArgs.parse(dropNulls(rest)));
    },
  },
  Mutation: {
    deleteFormResponse: async (_parent: unknown, args: { id: unknown }, ctx: GraphqlContext) => {
      await responses.deleteFormResponse(requireUser(ctx), parseRowId(args.id));
      return true;
    },
    setFormResponseStatus: (_parent: unknown, args: { id: unknown; status: unknown }, ctx: GraphqlContext) =>
      responses.setFormResponseStatus(requireUser(ctx), parseRowId(args.id), entryStatus.parse(args.status)),
  },
};

// GraphQL gửi null cho đối số tuỳ chọn bỏ trống; Zod coi null khác vắng mặt, nên bỏ null đi trước khi kiểm.
const dropNulls = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));

export const responsesModule = {
  typeDefs: readFileSync(join(__dirname, 'responses.graphql'), 'utf8'),
  resolvers,
};
