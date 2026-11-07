import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../../graphql/context';
import { requireUser } from '../../../graphql/guards';
import { parseCardId } from '../cards.schema';
import { publishArgs } from './publishing.schema';
import * as publishing from './publishing.service';

const resolvers = {
  Query: {
    publication: (_parent: unknown, args: { cardId: unknown }, ctx: GraphqlContext) =>
      publishing.getPublication(requireUser(ctx), parseCardId(args.cardId)),
  },
  Mutation: {
    publishCard: (_parent: unknown, args: { id: unknown; slug?: string | null }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      const { slug } = publishArgs.parse({ slug: args.slug || undefined });
      return publishing.publishCard(actor, parseCardId(args.id), slug);
    },
    unpublishCard: async (_parent: unknown, args: { id: unknown }, ctx: GraphqlContext) => {
      await publishing.unpublishCard(requireUser(ctx), parseCardId(args.id));
      return true;
    },
  },
};

export const publishingModule = {
  typeDefs: readFileSync(join(__dirname, 'publishing.graphql'), 'utf8'),
  resolvers,
};
