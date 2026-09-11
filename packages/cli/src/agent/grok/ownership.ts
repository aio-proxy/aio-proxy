import { AgentManagedMarkerSchema } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import { equalGrokLeaf, readGrokLeaf } from './toml';
import type { FieldChange, GrokMarker, GrokOwnership, GrokPath, GrokTransaction, LeafValue, OwnedLeaf } from './types';

const isIpv4Address = (host: string): boolean => {
  const octets = host.split('.');
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
};

export function isCanonicalLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname === '[::1]' ? '::1' : url.hostname;
    return (
      value === url.origin &&
      url.protocol === 'http:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      (host === 'localhost' || host === '::1' || (isIpv4Address(host) && host.split('.')[0] === '127'))
    );
  } catch {
    return false;
  }
}

const LeafValueSchema: z.ZodType<LeafValue> = z.union([
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({ present: z.literal(true), value: z.string(), raw: z.string() }),
]);
const GrokPathSchema: z.ZodType<GrokPath> = z.array(z.string());
const OwnedLeafSchema: z.ZodType<OwnedLeaf> = z.strictObject({
  path: GrokPathSchema,
  original: LeafValueSchema,
  written: LeafValueSchema,
});
const FieldChangeSchema: z.ZodType<FieldChange> = z.strictObject({
  path: GrokPathSchema,
  before: LeafValueSchema,
  after: LeafValueSchema,
});
const GrokTransactionSchema: z.ZodType<GrokTransaction> = z.strictObject({
  operation: z.enum(['configure', 'remove']),
  changes: z.array(FieldChangeSchema),
  nextLeaves: z.array(OwnedLeafSchema),
  nextCreatedTables: z.array(GrokPathSchema),
});

export const GrokMarkerSchema: z.ZodType<GrokMarker> = AgentManagedMarkerSchema.refine(
  (value): value is GrokMarker => value.agent === 'grok' && isCanonicalLoopbackOrigin(value.endpoint),
);

export const GrokOwnershipSchema: z.ZodType<GrokOwnership> = z
  .strictObject({
    format: z.literal(1),
    agent: z.literal('grok'),
    installationId: z.uuid(),
    endpoint: z.string(),
    status: z.enum(['active', 'removing']),
    leaves: z.array(OwnedLeafSchema),
    createdTables: z.array(GrokPathSchema),
    pending: GrokTransactionSchema.optional(),
    cleanupComplete: z.literal(true).optional(),
  })
  .refine((value) => isCanonicalLoopbackOrigin(value.endpoint))
  .refine((value) => value.cleanupComplete !== true || (value.status === 'removing' && value.pending === undefined));

export const pathKey = (path: GrokPath): string => JSON.stringify(path);

export const isNewerAdapter = (existing: string, requested: string): boolean => {
  try {
    return Bun.semver.order(existing, requested) > 0;
  } catch {
    return false;
  }
};

export type ParsedDocument = 'invalid' | 'newer' | 'v1';

export function peekManagedFormat(text: string): ParsedDocument {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return 'invalid';
    if (value['format'] === 1) return 'v1';
    if (typeof value['format'] === 'number' && Number.isSafeInteger(value['format']) && value['format'] > 1) {
      return 'newer';
    }
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

export function parseGrokMarker(text: string): GrokMarker {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Grok marker invalid');
  }
  const parsed = GrokMarkerSchema.safeParse(value);
  if (!parsed.success) throw new Error('Grok marker invalid');
  return parsed.data;
}

export function parseGrokOwnership(text: string): GrokOwnership {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Grok ownership invalid');
  }
  const parsed = GrokOwnershipSchema.safeParse(value);
  if (!parsed.success) throw new Error('Grok ownership invalid');
  return parsed.data;
}

export const encodeGrokMarker = (marker: GrokMarker): string => `${JSON.stringify(GrokMarkerSchema.parse(marker))}\n`;

export const encodeGrokOwnership = (ownership: GrokOwnership): string =>
  `${JSON.stringify(GrokOwnershipSchema.parse(ownership))}\n`;

export function classifyChange(current: LeafValue, change: FieldChange): 'before' | 'after' | 'conflict' {
  if (equalGrokLeaf(current, change.after)) return 'after';
  if (equalGrokLeaf(current, change.before)) return 'before';
  return 'conflict';
}

const readRecoverableLeaf = (text: string, path: GrokPath): LeafValue | undefined => {
  try {
    return readGrokLeaf(text, path);
  } catch {
    return undefined;
  }
};

const leafForPath = (leaves: readonly OwnedLeaf[], path: GrokPath): OwnedLeaf | undefined =>
  leaves.find((leaf) => pathKey(leaf.path) === pathKey(path));

function committedOwnership(
  ownership: GrokOwnership,
  leaves: readonly OwnedLeaf[],
  createdTables: readonly GrokPath[],
  pending?: GrokTransaction,
): GrokOwnership {
  return {
    format: 1,
    agent: 'grok',
    installationId: ownership.installationId,
    endpoint: ownership.endpoint,
    status: ownership.status,
    leaves,
    createdTables,
    ...(pending === undefined ? {} : { pending }),
    ...(pending === undefined && ownership.cleanupComplete === true ? { cleanupComplete: true } : {}),
  };
}

function remainingTransaction(
  pending: GrokTransaction,
  classifications: readonly {
    readonly change: FieldChange;
    readonly result: 'before' | 'after' | 'conflict';
    readonly current?: LeafValue;
  }[],
): GrokTransaction {
  const changes: FieldChange[] = [];
  for (const entry of classifications) {
    if (entry.result !== 'before' || entry.current === undefined) continue;
    changes.push({ path: entry.change.path, before: entry.current, after: entry.change.after });
  }
  return {
    operation: pending.operation,
    changes,
    nextLeaves: pending.nextLeaves,
    nextCreatedTables: pending.nextCreatedTables,
  };
}

export function recoverGrokOwnership(
  text: string,
  ownership: GrokOwnership,
): {
  readonly ownership: GrokOwnership;
  readonly conflicts: readonly string[];
} {
  const pending = ownership.pending;
  if (pending === undefined) return { ownership, conflicts: [] };

  const classifications = pending.changes.map((change) => {
    const current = readRecoverableLeaf(text, change.path);
    if (current === undefined) {
      return { change, result: 'conflict' as const };
    }
    return { change, result: classifyChange(current, change), current };
  });
  const conflicts = classifications
    .filter((entry) => entry.result === 'conflict')
    .map((entry) => entry.change.path.join('.'));
  const afterCount = classifications.filter((entry) => entry.result === 'after').length;
  const beforeCount = classifications.filter((entry) => entry.result === 'before').length;

  if (conflicts.length === 0 && afterCount === pending.changes.length) {
    return {
      ownership: committedOwnership(ownership, pending.nextLeaves, pending.nextCreatedTables),
      conflicts: [],
    };
  }

  if (conflicts.length === 0 && beforeCount === pending.changes.length) {
    return {
      ownership: committedOwnership(ownership, ownership.leaves, ownership.createdTables),
      conflicts: [],
    };
  }

  const determined: OwnedLeaf[] = [];
  const seen = new Set<string>();
  for (const entry of classifications) {
    const key = pathKey(entry.change.path);
    seen.add(key);
    if (entry.result === 'after') {
      if (pending.operation === 'remove') continue;
      const next = leafForPath(pending.nextLeaves, entry.change.path);
      if (next !== undefined) determined.push(next);
      continue;
    }
    const previous = leafForPath(ownership.leaves, entry.change.path);
    if (previous !== undefined) determined.push(previous);
  }
  for (const leaf of ownership.leaves) {
    if (!seen.has(pathKey(leaf.path))) determined.push(leaf);
  }

  const tables = afterCount > 0 ? pending.nextCreatedTables : ownership.createdTables;
  if (conflicts.length > 0) {
    return {
      ownership: committedOwnership(ownership, determined, tables, pending),
      conflicts,
    };
  }

  return {
    ownership: committedOwnership(ownership, determined, tables, remainingTransaction(pending, classifications)),
    conflicts: [],
  };
}
