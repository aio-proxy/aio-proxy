import { canonicalEffort } from '@aio-proxy/types';

export type PeeledWhen = {
  readonly thinking?: boolean;
  readonly effort?: string;
  readonly speed?: 'flex' | 'standard' | 'fast';
};

export type PeeledSlug = {
  readonly remainder: string;
  readonly when: PeeledWhen;
};

// Cursor wire ids append these axes to the family stem. Family words such as
// `mini` / `nano` / `flash` / `code` / `luna` / `sol` / `terra` are deliberately
// absent so they stay part of the stem.
const EFFORT_TOKENS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TWO_SEGMENT_EFFORT = 'extra-high';

type Peeled = { thinking?: boolean; effort?: string; speed?: 'fast' };

// Returns undefined when the slug is nothing but axis tokens: there is no family
// stem left to attach the variant to.
export function peelSlug(slug: string): PeeledSlug | undefined {
  let remainder = slug.trim();
  const when: Peeled = {};
  while (remainder.length > 0) {
    const peeledEffort = peelEffort(remainder, when);
    if (peeledEffort !== undefined) {
      remainder = peeledEffort;
      continue;
    }
    const tail = lastSegment(remainder);
    if (tail === 'thinking' && when.thinking === undefined) {
      when.thinking = true;
      remainder = dropLastSegment(remainder);
      continue;
    }
    if (tail === 'fast' && when.speed === undefined) {
      when.speed = 'fast';
      remainder = dropLastSegment(remainder);
      continue;
    }
    break;
  }
  if (remainder.length === 0) return undefined;
  return { remainder, when };
}

function peelEffort(slug: string, when: Peeled): string | undefined {
  if (when.effort !== undefined) return undefined;
  if (slug.endsWith(`-${TWO_SEGMENT_EFFORT}`) || slug === TWO_SEGMENT_EFFORT) {
    when.effort = canonicalEffort(TWO_SEGMENT_EFFORT);
    return slug.slice(0, Math.max(0, slug.length - TWO_SEGMENT_EFFORT.length - 1));
  }
  const tail = lastSegment(slug);
  if (!EFFORT_TOKENS.has(tail)) return undefined;
  when.effort = canonicalEffort(tail);
  return dropLastSegment(slug);
}

function lastSegment(slug: string): string {
  const index = slug.lastIndexOf('-');
  return index === -1 ? slug : slug.slice(index + 1);
}

function dropLastSegment(slug: string): string {
  const index = slug.lastIndexOf('-');
  return index === -1 ? '' : slug.slice(0, index);
}

export function whenIdentity(when: PeeledWhen): string {
  return [
    when.thinking === undefined ? '' : `thinking=${when.thinking}`,
    when.effort === undefined ? '' : `effort=${when.effort}`,
    when.speed === undefined ? '' : `speed=${when.speed}`,
  ]
    .filter((part) => part.length > 0)
    .join('|');
}

export function isEmptyWhen(when: PeeledWhen): boolean {
  return when.thinking === undefined && when.effort === undefined && when.speed === undefined;
}
