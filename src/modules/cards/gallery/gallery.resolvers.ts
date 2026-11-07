import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../../graphql/context';
import { requireUser } from '../../../graphql/guards';
import { AppError } from '../../../shared/errors';
import { adminListArgs, listTemplatesArgs, rejectReason } from './gallery.schema';
import * as gallery from './gallery.service';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
// Id sai dạng được coi như không có mẫu (NOT_FOUND), như với thiệp.
const parseId = (value: unknown): string => {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new AppError('NOT_FOUND', 'Template not found');
  return value;
};
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

const resolvers = {
  Query: {
    templates: (_p: unknown, args: { category?: string | null; first?: number | null; after?: string | null }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return gallery.listTemplates(actor, listTemplatesArgs.parse({ category: orUndefined(args.category), first: orUndefined(args.first), after: orUndefined(args.after) }));
    },
    template: (_p: unknown, args: { id: unknown }, ctx: GraphqlContext) => gallery.getTemplate(requireUser(ctx), parseId(args.id)),
    templateCounts: (_p: unknown, _args: unknown, ctx: GraphqlContext) => {
      requireUser(ctx);
      return gallery.templateCounts();
    },
    adminTemplates: (_p: unknown, args: { status: string; first?: number | null; after?: string | null }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return gallery.adminListTemplates(actor, adminListArgs.parse({ status: args.status, first: orUndefined(args.first), after: orUndefined(args.after) }));
    },
  },
  Mutation: {
    createCardFromTemplate: (_p: unknown, args: { id: unknown }, ctx: GraphqlContext) => gallery.useTemplate(requireUser(ctx), typeof args.id === 'string' ? args.id : ''),
    approveTemplate: (_p: unknown, args: { id: unknown }, ctx: GraphqlContext) => gallery.approveTemplate(requireUser(ctx), typeof args.id === 'string' ? args.id : ''),
    rejectTemplate: (_p: unknown, args: { id: unknown; reason: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      return gallery.rejectTemplate(actor, typeof args.id === 'string' ? args.id : '', rejectReason.parse(args.reason));
    },
    removeTemplate: (_p: unknown, args: { id: unknown }, ctx: GraphqlContext) => gallery.removeTemplate(requireUser(ctx), typeof args.id === 'string' ? args.id : ''),
  },
};

export const galleryModule = {
  typeDefs: readFileSync(join(__dirname, 'gallery.graphql'), 'utf8'),
  resolvers,
};
