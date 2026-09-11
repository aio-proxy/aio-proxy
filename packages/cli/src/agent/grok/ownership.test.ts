import { expect, test } from 'bun:test';

import { adoptRecoveredOwnership, classifyChange, encodeGrokOwnership, recoverGrokOwnership } from './ownership';
import { equalGrokLeaf } from './toml';
import type { FieldChange, GrokOwnership, LeafValue } from './types';

const absent: LeafValue = { present: false };
const value = (text: string): LeafValue => ({ present: true, value: text, raw: `"${text}"` });
const change = (path: readonly string[], before: LeafValue, after: LeafValue): FieldChange => ({
  path,
  before,
  after,
});

const owned = (path: readonly string[], original: LeafValue, written: LeafValue) => ({
  path,
  original,
  written,
});

const baseOwnership = (pending?: GrokOwnership['pending']): GrokOwnership => ({
  format: 1,
  agent: 'grok',
  installationId: '11111111-1111-4111-8111-111111111111',
  endpoint: 'http://127.0.0.1:9317',
  status: 'active',
  leaves: [owned(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy'))],
  createdTables: [['endpoints']],
  ...(pending === undefined ? {} : { pending }),
});

test('classifyChange prefers after, then before, then conflict', () => {
  const field = change(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy'));
  expect(classifyChange(value('AIO Proxy'), field)).toBe('after');
  expect(classifyChange(value('Cloud'), field)).toBe('before');
  expect(classifyChange(value('Mine'), field)).toBe('conflict');
  expect(classifyChange(absent, field)).toBe('conflict');
  const noop = change(['auth', 'keep'], value('same'), value('same'));
  expect(classifyChange(value('same'), noop)).toBe('after');
});

test('recover persists mixed after and before without marking before as written', () => {
  const pending = {
    operation: 'configure' as const,
    changes: [
      change(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy')),
      change(['endpoints', 'models_base_url'], absent, value('http://127.0.0.1:9317/v1')),
    ],
    nextLeaves: [
      owned(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy')),
      owned(['endpoints', 'models_base_url'], absent, value('http://127.0.0.1:9317/v1')),
    ],
    nextCreatedTables: [['endpoints']],
  };
  const ownership: GrokOwnership = {
    ...baseOwnership(pending),
    leaves: [owned(['auth', 'auth_provider_label'], value('Cloud'), value('Cloud'))],
  };
  const recovered = recoverGrokOwnership(
    '[auth]\nauth_provider_label = "Cloud"\n[endpoints]\nmodels_base_url = "http://127.0.0.1:9317/v1"\n',
    ownership,
  );
  expect(recovered.conflicts).toEqual([]);
  expect(recovered.ownership.pending).toEqual({
    operation: 'configure',
    changes: [change(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy'))],
    nextLeaves: pending.nextLeaves,
    nextCreatedTables: pending.nextCreatedTables,
  });
  expect(recovered.ownership.leaves).toEqual([
    owned(['auth', 'auth_provider_label'], value('Cloud'), value('Cloud')),
    owned(['endpoints', 'models_base_url'], absent, value('http://127.0.0.1:9317/v1')),
  ]);
  expect(recovered.ownership.leaves[0]?.written).toEqual(value('Cloud'));
});

test('recover adopts nextLeaves when every pending field is after', () => {
  const next = owned(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy'));
  const pending = {
    operation: 'configure' as const,
    changes: [change(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy'))],
    nextLeaves: [next],
    nextCreatedTables: [['auth']],
  };
  const recovered = recoverGrokOwnership('[auth]\nauth_provider_label = "AIO Proxy"\n', baseOwnership(pending));
  expect(recovered.conflicts).toEqual([]);
  expect(recovered.ownership.pending).toBeUndefined();
  expect(recovered.ownership.leaves).toEqual([next]);
  expect(recovered.ownership.createdTables).toEqual([['auth']]);
});

test('recover drops pending when every field is still before', () => {
  const pending = {
    operation: 'configure' as const,
    changes: [change(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy'))],
    nextLeaves: [owned(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy'))],
    nextCreatedTables: [['auth']],
  };
  const recovered = recoverGrokOwnership('[auth]\nauth_provider_label = "Cloud"\n', baseOwnership(pending));
  expect(recovered.conflicts).toEqual([]);
  expect(recovered.ownership.pending).toBeUndefined();
  expect(recovered.ownership.leaves).toEqual(baseOwnership().leaves);
  expect(recovered.ownership.createdTables).toEqual([['endpoints']]);
});

test('recover keeps pending when a first-install is still entirely before', () => {
  const pending = {
    operation: 'configure' as const,
    changes: [change(['auth', 'auth_provider_label'], absent, value('AIO Proxy'))],
    nextLeaves: [owned(['auth', 'auth_provider_label'], absent, value('AIO Proxy'))],
    nextCreatedTables: [['auth']],
  };
  const ownership: GrokOwnership = {
    ...baseOwnership(pending),
    leaves: [],
    createdTables: [],
  };
  const recovered = recoverGrokOwnership('', ownership);
  expect(recovered.conflicts).toEqual([]);
  expect(recovered.ownership.pending).toEqual(pending);
  expect(recovered.ownership.leaves).toEqual([]);
  const adopted = adoptRecoveredOwnership(ownership, encodeGrokOwnership(ownership), recovered);
  expect(adopted.persist).toBe(false);
  expect(adopted.ownership.pending).toEqual(pending);
  const dropped = {
    ownership: { ...ownership, pending: undefined },
    conflicts: [] as const,
  };
  const blocked = adoptRecoveredOwnership(ownership, encodeGrokOwnership(ownership), dropped);
  expect(blocked.persist).toBe(false);
  expect(blocked.ownership.pending).toEqual(pending);
});

test('recover keeps determined leaves and reports third values without treating before as written', () => {
  const pending = {
    operation: 'configure' as const,
    changes: [
      change(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy')),
      change(['endpoints', 'models_base_url'], absent, value('http://127.0.0.1:9317/v1')),
    ],
    nextLeaves: [
      owned(['auth', 'auth_provider_label'], value('Cloud'), value('AIO Proxy')),
      owned(['endpoints', 'models_base_url'], absent, value('http://127.0.0.1:9317/v1')),
    ],
    nextCreatedTables: [['endpoints']],
  };
  const ownership: GrokOwnership = {
    ...baseOwnership(pending),
    leaves: [owned(['auth', 'auth_provider_label'], value('Cloud'), value('Cloud'))],
  };
  const recovered = recoverGrokOwnership(
    '[auth]\nauth_provider_label = "Mine"\n[endpoints]\nmodels_base_url = "http://127.0.0.1:9317/v1"\n',
    ownership,
  );
  expect(recovered.conflicts).toEqual(['auth.auth_provider_label']);
  expect(recovered.ownership.pending).toEqual(pending);
  expect(recovered.ownership.leaves).toEqual([
    owned(['auth', 'auth_provider_label'], value('Cloud'), value('Cloud')),
    owned(['endpoints', 'models_base_url'], absent, value('http://127.0.0.1:9317/v1')),
  ]);
  expect(equalGrokLeaf(recovered.ownership.leaves[0]!.written, value('AIO Proxy'))).toBe(false);
});

test('recover does not retake a removed leaf that already matches after', () => {
  const pending = {
    operation: 'remove' as const,
    changes: [change(['auth', 'auth_provider_label'], value('AIO Proxy'), value('Cloud'))],
    nextLeaves: [],
    nextCreatedTables: [],
  };
  const recovered = recoverGrokOwnership('[auth]\nauth_provider_label = "Cloud"\n', baseOwnership(pending));
  expect(recovered.conflicts).toEqual([]);
  expect(recovered.ownership.leaves).toEqual([]);
});
