import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AiSdkProviderInstance, clearModelsCache, fileCacheStorage } from '@aio-proxy/core';
import { ConfigSchema, type ModelMetadata } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import type { ServerState } from '../../../server-state';
import { agentCatalog } from './agent-catalog';

const original = process.env.AIO_PROXY_HOME;
let catalogHome: string;
const cleanupHomes: string[] = [];
const states: ServerState[] = [];

beforeEach(async () => {
  catalogHome = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-catalog-models-dev-'));
  process.env.AIO_PROXY_HOME = catalogHome;
  clearModelsCache();
  await fileCacheStorage.setItem('models-dev-providers', { openrouter: { models: {} } });
});

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const home of cleanupHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  clearModelsCache();
  rmSync(catalogHome, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

async function catalogState(input: { readonly metadata: Record<string, ModelMetadata> }) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-catalog-'));
  cleanupHomes.push(home);
  const provider = {
    id: 'provider-a',
    kind: 'ai-sdk',
    enabled: true,
    models: ['defaults', 'explicit'],
    alias: {
      defaults: { model: 'defaults', preserve: false },
      explicit: { model: 'explicit', preserve: false },
    },
    invoke: () => new ReadableStream(),
  } satisfies AiSdkProviderInstance;
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {},
      router: {
        models: Object.fromEntries(Object.entries(input.metadata).map(([slug, metadata]) => [slug, { metadata }])),
      },
    }),
    dbHome: home,
    providerInstances: [provider],
  });
  states.push(state);
  return state;
}

test('assembler fixes neutral defaults and honors resolved metadata', async () => {
  const state = await catalogState({
    metadata: {
      explicit: {
        name: 'Explicit',
        capabilities: {
          reasoning: true,
          toolCall: false,
          temperature: true,
          attachment: true,
          modalities: { input: ['text', 'image'] },
        },
        limit: { context: 200_000, output: 64_000 },
      },
    },
  });
  await expect(agentCatalog(state, 'pi')).resolves.toEqual({
    schema_version: 1,
    agent: 'pi',
    models: [
      {
        id: 'defaults',
        name: 'defaults',
        reasoning: false,
        tool_call: true,
        temperature: false,
        attachment: false,
        input: ['text'],
        context_window: null,
        max_output_tokens: null,
      },
      {
        id: 'explicit',
        name: 'Explicit',
        reasoning: true,
        tool_call: false,
        temperature: true,
        attachment: true,
        input: ['text', 'image'],
        context_window: 200_000,
        max_output_tokens: 64_000,
      },
    ],
  });
});
