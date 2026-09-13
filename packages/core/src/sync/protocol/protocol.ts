import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { parseHead, parseRevision } from './schemas';

export type { JsonValue } from '@aio-proxy/plugin-sdk';

export type EntityKind = 'provider' | 'model-rule' | 'plugin-business' | 'service-access' | 'routing-defaults';

/**
 * An edge from an entity body to something it needs. Two meanings share one shape so that every
 * consumer can traverse the sync graph through `objectId`: a plugin requirement names an installed
 * npm package in `packageName`, while a Provider reference names another synchronized entity and
 * carries {@link PROVIDER_REFERENCE} instead. Use {@link isPluginRequirement} before reading
 * `packageName` as a package.
 */
export interface Dependency {
  objectId: string;
  packageName: string;
  version: string;
}

/**
 * `packageName` marker for a reference to a synchronized Provider entity. A colon cannot appear in
 * an npm package name, so this never collides with a real plugin requirement.
 */
const PROVIDER_REFERENCE = 'sync:provider';

/**
 * A model rule's edge to a Provider it routes to. `version` carries the Provider entity epoch the
 * rule was projected against, not a package version.
 */
export function providerReference(provider: { objectId: string; epoch: number }): Dependency {
  return { objectId: provider.objectId, packageName: PROVIDER_REFERENCE, version: String(provider.epoch) };
}

/**
 * Whether a dependency requires an installed plugin package. Provider references resolve against
 * synchronized entities instead, so callers that validate plugin installation must skip them.
 */
export function isPluginRequirement(dependency: Dependency): boolean {
  return dependency.packageName !== PROVIDER_REFERENCE;
}

export interface EntityBody {
  kind: EntityKind;
  logicalKey: string;
  value: JsonValue;
  dependencies: Dependency[];
}

export interface EntityHead {
  protocol: 1;
  objectId: string;
  kind: EntityKind;
  logicalKey: string;
  epoch: number;
  sequence: number;
  state: 'active' | 'deleted' | 'purging' | 'purged';
  current: string | null;
  history: string[];
  reserved: string[];
  cancelling: string[];
  receipts: Record<string, number>;
  cleanupComplete: boolean;
}

/**
 * An operation ID is an unrestricted wire string, so `receipts['toString']` would otherwise resolve
 * the inherited function and be mistaken for a publication sequence.
 */
export function receiptSequence(head: EntityHead, operationId: string): number | undefined {
  return Object.hasOwn(head.receipts, operationId) ? head.receipts[operationId] : undefined;
}

export type RevisionRecord =
  | {
      protocol: 1;
      state: 'payload';
      objectId: string;
      epoch: number;
      operationId: string;
      body: EntityBody;
      publishedSequence: number | null;
      writtenAt: number | null;
    }
  | {
      protocol: 1;
      state: 'erased';
      objectId: string;
      epoch: number;
      operationId: string;
      publishedSequence: number | null;
      reason: 'expired' | 'purged' | 'abandoned';
    };

export interface DeletedAccount {
  protocol: 1;
  phase: 'deleted';
  objectId: string;
  epoch: number;
}

export function entityKey(objectId: string): string {
  return `s/v1/default/entity/${objectId}`;
}

export function revisionKey(objectId: string, operationId: string): string {
  return `s/v1/default/revision/${objectId}/${operationId}`;
}

export function accountKey(objectId: string): string {
  return `s/v1/default/account/${objectId}`;
}

export function encode(value: unknown): Uint8Array {
  try {
    assertJsonValue(value, new Set());
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new SyncProtocolError('invalid-data', 'value is not JSON');
    return new TextEncoder().encode(encoded);
  } catch (error) {
    if (error instanceof SyncProtocolError) throw error;
    throw new SyncProtocolError('invalid-data', 'value is not JSON');
  }
}

export function decodeHead(bytes: Uint8Array): EntityHead {
  return decode(bytes, parseHead) as EntityHead;
}

export function decodeRevision(bytes: Uint8Array): RevisionRecord {
  return decode(bytes, parseRevision) as RevisionRecord;
}

function decode(bytes: Uint8Array, parse: (value: unknown) => unknown): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SyncProtocolError('invalid-data', 'invalid JSON');
  }
  if (typeof value === 'object' && value !== null && 'protocol' in value && value.protocol !== 1) {
    throw new SyncProtocolError('upgrade-required', 'upgrade-required: unsupported protocol version');
  }
  try {
    return parse(value);
  } catch {
    throw new SyncProtocolError('invalid-data', 'invalid sync record');
  }
}

function assertJsonValue(value: unknown, seen: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new SyncProtocolError('invalid-data', 'JSON numbers must be finite');
  }
  if (typeof value !== 'object') throw new SyncProtocolError('invalid-data', 'value is not JSON');
  if (seen.has(value)) throw new SyncProtocolError('invalid-data', 'value contains a cycle');
  seen.add(value);
  if (Array.isArray(value)) {
    if ('toJSON' in value) {
      throw new SyncProtocolError('invalid-data', 'value is not a plain JSON array');
    }
    for (const item of value) assertJsonValue(item, seen);
  } else {
    if (!isPlainObject(value) || Object.prototype.hasOwnProperty.call(value, 'toJSON')) {
      throw new SyncProtocolError('invalid-data', 'value is not a plain JSON object');
    }
    for (const item of Object.values(value)) assertJsonValue(item, seen);
  }
  seen.delete(value);
}

export class SyncProtocolError extends Error {
  override readonly name = 'SyncProtocolError';

  constructor(
    readonly code: 'upgrade-required' | 'deleted' | 'epoch-mismatch' | 'invalid-data',
    message: string,
  ) {
    super(message);
  }
}
