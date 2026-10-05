import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type OpenDbHandle, openDb } from '../db';
import { createProviderModelCatalogRepository } from '../index';

const fixtures: Array<{ home: string; handle: OpenDbHandle }> = [];

afterEach(() => {
  for (const { home, handle } of fixtures.splice(0)) {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-provider-model-catalog-'));
  const handle = openDb({ home });
  fixtures.push({ home, handle });
  return { repo: createProviderModelCatalogRepository(handle.sqlite), sqlite: handle.sqlite };
}

test('read returns null for an unknown Provider ID', () => {
  const { repo } = fixture();
  repo.writeSuccess('known', 'digest-a', ['gpt-5'], 1_000);

  expect(repo.read('unknown')).toBeNull();
});

test('writeSuccess then read round-trips the model list and clears a prior failure', () => {
  const { repo } = fixture();
  repo.writeFailure('provider-a', 'digest-a', 'CATALOG_UNSUPPORTED', 500);
  expect(repo.read('provider-a')).toEqual({
    sourceDigest: 'digest-a',
    models: null,
    refreshedAt: null,
    failure: { code: 'CATALOG_UNSUPPORTED', at: 500 },
  });

  const models = ['gpt-5', 'model/with-"quotes"', '模型'] as const;
  repo.writeSuccess('provider-a', 'digest-b', models, 1_000);
  expect(repo.read('provider-a')).toEqual({
    sourceDigest: 'digest-b',
    models,
    refreshedAt: 1_000,
    failure: null,
  });

  repo.writeSuccess('provider-a', 'digest-b', ['gpt-5-mini'], 2_000);
  expect(repo.read('provider-a')).toEqual({
    sourceDigest: 'digest-b',
    models: ['gpt-5-mini'],
    refreshedAt: 2_000,
    failure: null,
  });
});

test('writeFailure keeps the last good models for the same source digest', () => {
  const { repo } = fixture();
  repo.writeSuccess('provider-a', 'digest-a', ['gpt-5', 'gpt-5-mini'], 1_000);
  repo.writeFailure('provider-a', 'digest-a', 'CATALOG_UNAVAILABLE', 2_000);

  expect(repo.read('provider-a')).toEqual({
    sourceDigest: 'digest-a',
    models: ['gpt-5', 'gpt-5-mini'],
    refreshedAt: 1_000,
    failure: { code: 'CATALOG_UNAVAILABLE', at: 2_000 },
  });
});

test('writeFailure under a new source digest drops the old models', () => {
  const { repo } = fixture();
  repo.writeSuccess('provider-a', 'digest-a', ['gpt-5'], 1_000);
  repo.writeSuccess('provider-b', 'digest-a', ['gpt-5-mini'], 1_500);
  repo.writeFailure('provider-a', 'digest-b', 'CATALOG_UNAVAILABLE', 2_000);

  expect(repo.read('provider-a')).toEqual({
    sourceDigest: 'digest-b',
    models: null,
    refreshedAt: null,
    failure: { code: 'CATALOG_UNAVAILABLE', at: 2_000 },
  });
  expect(repo.read('provider-b')).toEqual({
    sourceDigest: 'digest-a',
    models: ['gpt-5-mini'],
    refreshedAt: 1_500,
    failure: null,
  });
});

test.each(['{"a":1}', '[1,2]'])('read rejects malformed stored model lists: %s', (modelsJson) => {
  const { repo, sqlite } = fixture();
  repo.writeSuccess('provider-a', 'digest-a', ['gpt-5'], 1_000);
  sqlite.query('UPDATE provider_model_catalog SET models_json = ? WHERE provider_id = ?').run(modelsJson, 'provider-a');

  expect(() => repo.read('provider-a')).toThrow('models_json must be an array of strings');
});
