import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphqlContext } from '../../../graphql/context';
import { requireUser } from '../../../graphql/guards';
import { parseCardId } from '../cards.schema';
import { guestEntries, guestPatch, guestSearch, parseGuestId } from './guests.schema';
import * as guests from './guests.service';

// GraphQL gửi null cho đối số tuỳ chọn bỏ trống; với tên thì null nghĩa là không đổi, với lời chào thì null nghĩa là xoá.
const resolvers = {
  Query: {
    cardGuests: (_parent: unknown, args: { cardId: unknown; search?: unknown }, ctx: GraphqlContext) =>
      guests.listGuests(requireUser(ctx), parseCardId(args.cardId), guestSearch.parse(args.search ?? undefined) || undefined),
  },
  Mutation: {
    addGuests: (_parent: unknown, args: { cardId: unknown; entries: unknown }, ctx: GraphqlContext) =>
      guests.addGuests(requireUser(ctx), parseCardId(args.cardId), guestEntries.parse(args.entries)),
    updateGuest: (_parent: unknown, args: { id: unknown; name?: unknown; greeting?: unknown; inviteMessage?: unknown }, ctx: GraphqlContext) => {
      const actor = requireUser(ctx);
      const patch = guestPatch.parse({ ...(args.name != null ? { name: args.name } : {}), ...(args.greeting !== undefined ? { greeting: args.greeting } : {}), ...(args.inviteMessage !== undefined ? { inviteMessage: args.inviteMessage } : {}) });
      return guests.updateGuest(actor, parseGuestId(args.id), patch);
    },
    deleteGuest: async (_parent: unknown, args: { id: unknown }, ctx: GraphqlContext) => {
      await guests.deleteGuest(requireUser(ctx), parseGuestId(args.id));
      return true;
    },
  },
};

export const guestsModule = {
  typeDefs: readFileSync(join(__dirname, 'guests.graphql'), 'utf8'),
  resolvers,
};
