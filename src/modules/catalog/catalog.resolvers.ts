import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../graphql/context';
import { requireUser } from '../../graphql/guards';
import * as catalog from './catalog.service';

const resolvers = {
  Query: {
    photoFrameShapes: (_parent: unknown, args: { first?: number | null; after?: string | null }, ctx: GraphqlContext) => {
      requireUser(ctx);
      return catalog.listPhotoFrameShapes(args.first, args.after);
    },
    decorativeAssets: (_parent: unknown, args: { category?: string | null; search?: string | null; first?: number | null; after?: string | null }, ctx: GraphqlContext) => {
      requireUser(ctx);
      return catalog.listDecorativeAssets(args.category, args.search, args.first, args.after);
    },
  },
  Mutation: {
    savePhotoFrameShape: (_parent: unknown, args: { input: unknown }, ctx: GraphqlContext) => catalog.savePhotoFrameShape(requireUser(ctx), args.input),
    retirePhotoFrameShape: (_parent: unknown, args: { id: string }, ctx: GraphqlContext) => catalog.retirePhotoFrameShape(requireUser(ctx), args.id),
    createDecorativeAsset: (_parent: unknown, args: { input: unknown }, ctx: GraphqlContext) => catalog.createDecorativeAsset(requireUser(ctx), args.input),
    updateDecorativeAsset: (_parent: unknown, args: { id: string; name?: string | null; category?: string | null; tags?: string[] | null; sortOrder?: number | null }, ctx: GraphqlContext) => {
      const patch = Object.fromEntries(Object.entries(args).filter(([key, value]) => key !== 'id' && value !== null && value !== undefined));
      return catalog.updateDecorativeAsset(requireUser(ctx), args.id, patch);
    },
    retireDecorativeAsset: (_parent: unknown, args: { id: string }, ctx: GraphqlContext) => catalog.retireDecorativeAsset(requireUser(ctx), args.id),
  },
};

export const catalogModule = {
  typeDefs: readFileSync(join(__dirname, 'catalog.graphql'), 'utf8'),
  resolvers,
};
