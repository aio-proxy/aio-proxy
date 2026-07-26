import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../../runtime';
import type { ServerState } from '../../../server-state';
import { codexClientModels } from './codex-client-models';

const provider = {
  id: 'p1',
  kind: ProviderKind.OAuth,
  enabled: true,
  alias: {
    'gpt-5': { model: 'gpt-5.6-sol', preserve: false },
    'my-alias': { model: 'third-party-model', preserve: false },
  },
  modelMetadata: {},
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(): ServerState {
  return {
    acquireProviderSnapshot: () => ({ snapshot: { providers: [provider] }, release() {} }),
    modelsDevCatalog: async () => undefined,
  } as unknown as ServerState;
}

const upstream = {
  slug: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol',
  priority: 1,
  supported_in_api: true,
  visibility: 'list',
  base_instructions: 'UPSTREAM VERBATIM',
  availability_nux: { message: 'keep me' },
};

const original = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-client-models-'));
  process.env.AIO_PROXY_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

test('case A returns upstream verbatim with alias slug/id; case B synthesizes without availability_nux', async () => {
  const fetchImpl = (async () => Response.json({ models: [upstream] })) as unknown as typeof fetch;
  const { models } = await codexClientModels(fakeState(), { fetchImpl });

  const caseA = models.find((m) => m.id === 'gpt-5');
  expect(caseA).toBeDefined();
  const caseAEntry = caseA as Record<string, unknown>;
  expect(caseAEntry.slug).toBe('gpt-5');
  expect(caseAEntry.base_instructions).toBe('UPSTREAM VERBATIM');
  expect(caseAEntry.availability_nux).toEqual({ message: 'keep me' });

  const caseB = models.find((m) => m.id === 'my-alias');
  expect(caseB).toBeDefined();
  const caseBEntry = caseB as Record<string, unknown>;
  expect(caseBEntry.slug).toBe('my-alias');
  expect('availability_nux' in caseBEntry).toBe(false);
  expect((caseBEntry.base_instructions as string).includes('based on my-alias.')).toBe(true);
});
