import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import { ModelIdSchema } from '../model-id';

export const EFFORT_SPELLING: Readonly<Record<string, string>> = {
  'x-high': 'xhigh',
  x_high: 'xhigh',
  extrahigh: 'xhigh',
  'extra-high': 'xhigh',
};

export function foldEffortSpelling(lowercased: string): string {
  return EFFORT_SPELLING[lowercased] ?? lowercased;
}

export function canonicalEffort(value: string): string {
  return foldEffortSpelling(value.trim().toLowerCase());
}

/** Ascending reasoning-effort ladder shared by alias routing and wire-path clamping. Index = rank. */
export const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Rank of an effort on EFFORT_LADDER after spelling folding, or -1 when off-ladder. */
export function effortRank(effort: string): number {
  return EFFORT_LADDER.indexOf(canonicalEffort(effort) as (typeof EFFORT_LADDER)[number]);
}

export type AliasSpeed = 'flex' | 'standard' | 'fast';
export type AliasWhen = {
  readonly effort?: string;
  readonly thinking?: boolean;
  readonly speed?: AliasSpeed;
};
export type AliasSelectRow = {
  readonly when: AliasWhen;
  readonly model: string;
  readonly preserve: boolean;
};
export type AliasDimensions = {
  readonly effort?: string;
  readonly thinking?: boolean;
  readonly speed?: AliasSpeed;
};

const WHEN_KEYS = ['thinking', 'effort', 'speed'] as const;

const AliasTargetObjectSchema = z.object({
  model: ModelIdSchema.describe('Default upstream model id for this alias target.'),
  preserve: z.boolean().default(false).describe('Expose the target model under its original id as well.'),
});

export const AliasTargetSchema = z
  .union([ModelIdSchema, AliasTargetObjectSchema])
  .transform((value) => (typeof value === 'string' ? { model: value, preserve: false } : value));

export const AliasWhenSchema = z
  .strictObject({
    effort: z.string().optional().describe('Requested reasoning effort, canonicalized case-insensitively.'),
    thinking: z.boolean().optional().describe('Whether the request asks for thinking output.'),
    speed: z.enum(['flex', 'standard', 'fast']).optional().describe('Requested service tier.'),
  })
  .refine((when) => WHEN_KEYS.some((key) => when[key] !== undefined), {
    message: 'Alias when must specify at least one of thinking, effort, or speed',
  });

export const AliasSelectRowSchema = z.object({
  when: AliasWhenSchema,
  model: ModelIdSchema,
  preserve: z.boolean().default(false).describe('Expose the target model under its original id as well.'),
});

const AliasVariantsRecordSchema = z.record(z.string().min(1), AliasTargetSchema).transform((variants) =>
  Object.entries(variants).map(([key, target]) => ({
    when: { effort: canonicalEffort(key) },
    model: target.model,
    preserve: target.preserve,
  })),
);

// Array first: Zod 4's z.record rejects arrays outright, so array inputs fall through to the record branch otherwise.
export const AliasVariantsSchema = z.union([z.array(AliasSelectRowSchema), AliasVariantsRecordSchema]);

/**
 * The identity the server rejects duplicates on. Exported so an editor can reject the same pair
 * before it builds a payload `rejectDuplicateWhen` would refuse.
 */
export function whenIdentity(when: AliasWhen): string {
  const parts: string[] = [];
  if (when.thinking !== undefined) parts.push(`thinking=${when.thinking}`);
  if (when.effort !== undefined) parts.push(`effort=${canonicalEffort(when.effort)}`);
  if (when.speed !== undefined) parts.push(`speed=${when.speed}`);
  return parts.join('|');
}

function rejectDuplicateWhen(
  config: { readonly variants?: readonly AliasSelectRow[] | undefined },
  ctx: z.RefinementCtx,
): void {
  const variants = config.variants;
  if (variants === undefined) return;
  const seen = new Set<string>();
  for (const [index, row] of variants.entries()) {
    const id = whenIdentity(row.when);
    if (seen.has(id)) {
      ctx.addIssue({ code: 'custom', message: `Duplicate alias when "${id}"`, path: ['variants', index] });
    }
    seen.add(id);
  }
}

export const AliasConfigSchema = z
  .union([
    ModelIdSchema,
    AliasTargetObjectSchema.extend({ variants: AliasVariantsSchema.optional() }).superRefine(rejectDuplicateWhen),
  ])
  .transform((value) => (typeof value === 'string' ? { model: value, preserve: false } : value));

export type AliasTargetInput = z.input<typeof AliasTargetSchema>;
export type AliasTarget = z.output<typeof AliasTargetSchema>;
export type AliasConfigInput = z.input<typeof AliasConfigSchema>;
export type AliasConfig = z.output<typeof AliasConfigSchema>;

export function isAliasVariantSelect(variants: unknown): variants is readonly AliasSelectRow[] {
  return Array.isArray(variants);
}

export function isAliasVariantsObject(variants: unknown): variants is Readonly<Record<string, AliasTarget>> {
  return variants !== undefined && isPlainObject(variants);
}

function canonicalizeSpeed(value: string): AliasSpeed | undefined {
  const speed = value.trim().toLowerCase();
  return speed === 'flex' || speed === 'standard' || speed === 'fast' ? speed : undefined;
}

function canonicalizeWhen(when: AliasWhen): AliasWhen {
  return {
    ...(when.thinking === undefined ? {} : { thinking: when.thinking }),
    ...(when.effort === undefined ? {} : { effort: canonicalEffort(when.effort) }),
    ...(when.speed === undefined
      ? {}
      : (() => {
          const speed = canonicalizeSpeed(when.speed);
          return speed === undefined ? {} : { speed };
        })()),
  };
}

function canonicalizeDimensions(dimensions: AliasDimensions): AliasDimensions {
  return canonicalizeWhen(dimensions);
}

export function flattenAliasVariants(
  variants: AliasConfig['variants'] | readonly AliasSelectRow[] | Readonly<Record<string, AliasTarget>> | undefined,
): readonly AliasSelectRow[] {
  if (variants === undefined) return [];
  if (Array.isArray(variants)) {
    return variants.map((row) => ({
      when: canonicalizeWhen(row.when),
      model: row.model,
      preserve: row.preserve ?? false,
    }));
  }
  return Object.entries(variants).map(([key, target]) => ({
    when: { effort: canonicalEffort(key) },
    model: target.model,
    preserve: target.preserve,
  }));
}

function specifiedKeys(when: AliasWhen): ReadonlySet<(typeof WHEN_KEYS)[number]> {
  const keys = new Set<(typeof WHEN_KEYS)[number]>();
  for (const key of WHEN_KEYS) {
    if (when[key] !== undefined) keys.add(key);
  }
  return keys;
}

function rowMatches(when: AliasWhen, bag: AliasDimensions): boolean {
  for (const key of WHEN_KEYS) {
    const expected = when[key];
    if (expected === undefined) continue;
    if (bag[key] !== expected) return false;
  }
  return true;
}

function isStrictSubset(inner: AliasWhen, outer: AliasWhen): boolean {
  const innerKeys = specifiedKeys(inner);
  const outerKeys = specifiedKeys(outer);
  if (innerKeys.size >= outerKeys.size) return false;
  for (const key of innerKeys) {
    if (!outerKeys.has(key)) return false;
  }
  return true;
}

/**
 * Match precedence between two rows that both match a request. Exported so an editor can show rows
 * in the order they actually win in, rather than inventing a second scoring rule that drifts.
 */
export function whenRank(when: AliasWhen): number {
  return (
    (when.thinking === undefined ? 0 : 4) + (when.effort === undefined ? 0 : 2) + (when.speed === undefined ? 0 : 1)
  );
}

export function matchAliasRows(
  rows: readonly AliasSelectRow[],
  dimensions: AliasDimensions,
  fallback: AliasTarget,
): AliasTarget {
  const bag = canonicalizeDimensions(dimensions);
  const matches = rows.filter((row) => rowMatches(row.when, bag));
  // A row that constrains `effort` is direct evidence for the requested level, so it wins
  // outright. When nothing that matched constrains effort — no match at all, or only
  // effort-blind rows such as Antigravity's `{ thinking: true }` catch-all — the winner would
  // be picked with the request's effort ignored, so the ceiling gets to answer first.
  if (matches.every((row) => row.when.effort === undefined)) {
    const ceiling = effortCeiling(rows, bag);
    if (ceiling !== undefined) return ceiling;
  }
  if (matches.length === 0) return fallback;
  const maximal = matches.filter(
    (row) => !matches.some((other) => other !== row && isStrictSubset(row.when, other.when)),
  );
  let winner = maximal[0]!;
  for (const row of maximal.slice(1)) {
    if (whenRank(row.when) > whenRank(winner.when)) winner = row;
  }
  return { model: winner.model, preserve: winner.preserve };
}

// A request asking above every effort row this alias declares must reuse the
// alias's top effort row, not drop to the base model (which is typically a lower
// tier). Two cases deliberately fall back instead: an effort inside a gap between
// rows (a higher row exists), and a ceiling below `medium` (the alias base is
// conventionally the medium tier, so a `low` wire would downgrade below it).
const CEILING_FLOOR_RANK = EFFORT_LADDER.indexOf('medium');

function effortCeiling(rows: readonly AliasSelectRow[], bag: AliasDimensions): AliasTarget | undefined {
  const wanted = bag.effort === undefined ? -1 : effortRank(bag.effort);
  if (wanted === -1) return undefined;
  let best: { readonly row: AliasSelectRow; readonly rank: number } | undefined;
  for (const row of rows) {
    if (row.when.effort === undefined) continue;
    // Every non-effort constraint must still hold, so a thinking-only variant
    // never captures a non-thinking request.
    if (!rowMatches({ ...row.when, effort: undefined }, bag)) continue;
    const rank = effortRank(row.when.effort);
    // An off-ladder row is a sentinel addressed by exact name (Antigravity emits
    // `hidden:<wire id>` for suppressed wires); it is not part of the ladder this
    // request is measured against, so it must not abort the search.
    if (rank === -1) continue;
    if (rank >= wanted) return undefined;
    if (best === undefined || rank > best.rank || (rank === best.rank && whenRank(row.when) > whenRank(best.row.when)))
      best = { row, rank };
  }
  if (best === undefined || best.rank < CEILING_FLOOR_RANK) return undefined;
  return { model: best.row.model, preserve: best.row.preserve };
}

export function resolveAliasTarget(config: AliasConfig, dimensions: AliasDimensions = {}): AliasTarget {
  return matchAliasRows(flattenAliasVariants(config.variants), dimensions, {
    model: config.model,
    preserve: config.preserve,
  });
}
