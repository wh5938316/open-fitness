import { z } from 'zod';
import { base64url } from '../crypto';
import type { FitnessService } from '../domain/service';
import { AppError } from '../errors';

export const FEED_EPOCH = 1;
export const FEED_MAX_BYTES = 512 * 1024;

interface CursorBody {
  v: 1;
  e: number;
  o: string;
  s: number;
}

export function encodeFeedCursor(ownerId: string, seq: number): string {
  return base64url(
    new TextEncoder().encode(
      JSON.stringify({ v: 1, e: FEED_EPOCH, o: ownerId, s: seq } satisfies CursorBody),
    ),
  );
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

export type DecodedFeedCursor =
  | { status: 'start' }
  | { status: 'reset' }
  | { status: 'mismatch' }
  | { status: 'ok'; seq: number };

export function decodeFeedCursor(cursor: string | undefined, ownerId: string): DecodedFeedCursor {
  if (cursor === undefined) return { status: 'start' };
  try {
    const parsed = JSON.parse(decodeBase64Url(cursor)) as Partial<CursorBody>;
    if (typeof parsed.o === 'string' && parsed.o !== ownerId) return { status: 'mismatch' };
    if (
      parsed.v !== 1 ||
      parsed.e !== FEED_EPOCH ||
      typeof parsed.o !== 'string' ||
      typeof parsed.s !== 'number' ||
      !Number.isSafeInteger(parsed.s) ||
      parsed.s < 0
    )
      return { status: 'reset' };
    return { status: 'ok', seq: parsed.s };
  } catch {
    return { status: 'reset' };
  }
}

export function registerFeedOperations(service: FitnessService): void {
  service.add({
    name: 'list_changes',
    description:
      'Read documents changed after a cursor, including tombstones, in commit order. Native clients use this feed for local sync. Prefer the specific read tools when answering a question.',
    schema: z.object({
      after: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    readOnly: true,
    method: 'GET',
    path: '/sync/changes',
    run: async (args: { after?: string; limit: number }) => {
      const decoded = decodeFeedCursor(args.after, service.actor.ownerId);
      const account = {
        ownerId: service.actor.ownerId,
        timeZone: service.actor.timeZone,
        locale: service.actor.locale,
      };
      if (decoded.status === 'mismatch')
        throw new AppError(409, 'SYNC_OWNER_MISMATCH', 'syncOwnerMismatch');
      if (decoded.status === 'reset')
        return { items: [], cursor: null, hasMore: false, reset: true, account };
      const afterSeq = decoded.status === 'ok' ? decoded.seq : 0;
      const page = await service.repository.changes(
        service.actor.ownerId,
        afterSeq,
        args.limit,
        FEED_MAX_BYTES,
      );
      return {
        items: page.items,
        cursor: encodeFeedCursor(service.actor.ownerId, page.lastSeq),
        hasMore: page.hasMore,
        reset: false,
        account,
      };
    },
  });
}
