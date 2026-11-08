import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../../graphql/context';
import { requireUser } from '../../../graphql/guards';
import { parseCardId } from '../cards.schema';
import { parsePublicationId, publishInput } from './publishing.schema';
import * as publishing from './publishing.service';

const resolvers = {
  Query: {
    publication: (_parent: unknown, args: { cardId: unknown }, ctx: GraphqlContext) =>
      publishing.getPublication(requireUser(ctx), parseCardId(args.cardId)),
    publications: (_parent: unknown, args: { cardId: unknown }, ctx: GraphqlContext) =>
      publishing.getPublications(requireUser(ctx), parseCardId(args.cardId)),
  },
  Mutation: {
    publishCard: (
      _parent: unknown,
      args: { id: unknown; slug?: string | null; listInGallery?: boolean | null; publicationId?: string | null; label?: string | null },
      ctx: GraphqlContext,
    ) => {
      const actor = requireUser(ctx);
      const input = publishInput.parse({ slug: args.slug || undefined, publicationId: args.publicationId ? parsePublicationId(args.publicationId) : undefined, label: args.label ?? undefined });
      return publishing.publishCard(actor, parseCardId(args.id), { ...input, listInGallery: args.listInGallery ?? false });
    },
    unpublishPublication: async (_parent: unknown, args: { cardId: unknown; publicationId: unknown }, ctx: GraphqlContext) => {
      await publishing.unpublishPublication(requireUser(ctx), parseCardId(args.cardId), parsePublicationId(args.publicationId));
      return true;
    },
    unpublishCard: async (_parent: unknown, args: { id: unknown }, ctx: GraphqlContext) => {
      await publishing.unpublishCard(requireUser(ctx), parseCardId(args.id));
      return true;
    },
    restoreDraftFromPublication: (_parent: unknown, args: { cardId: unknown; publicationId: unknown }, ctx: GraphqlContext) =>
      publishing.restoreDraftFromPublication(requireUser(ctx), parseCardId(args.cardId), parsePublicationId(args.publicationId)),
  },
};

export const publishingModule = {
  typeDefs: readFileSync(join(__dirname, 'publishing.graphql'), 'utf8'),
  resolvers,
};
