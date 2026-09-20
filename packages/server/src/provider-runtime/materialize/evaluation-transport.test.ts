import { expect, test } from 'bun:test';

import type { ProviderFetch } from '@aio-proxy/core';
import { ConfigSchema, type Provider } from '@aio-proxy/types';

import { supportsEvaluation } from '../capability-index';
import { evaluationMaterialization } from './evaluation-transport';
import { materializeProviders } from './materialize';

function aiSdkConfig(packageName: string): Provider {
  const config = ConfigSchema.parse({
    providers: { sdk: { kind: 'ai-sdk', packageName, models: ['judge-1'] } },
  });
  return config.providers[0]!;
}

function apiConfig(provider: Record<string, unknown>): Provider {
  const config = ConfigSchema.parse({
    providers: { api: { kind: 'api', baseURL: 'https://api.example.com', models: ['judge-1'], ...provider } },
  });
  return config.providers[0]!;
}

const loadsNothing = async () => {
  throw new Error('discovery must not load at materialization');
};

test('grants evaluation to an Anthropic-primary API provider and attaches its transport', () => {
  const materialized = evaluationMaterialization(apiConfig({ protocol: 'anthropic' }), {
    loadProvider: loadsNothing,
  });

  expect(materialized?.grantsCapability).toBe(true);
  expect(typeof materialized?.transport.evaluate).toBe('function');
});

// The companion negative to the grant above: `openai-compatible` is excluded by
// PROTOCOL_CAPABILITIES, which is the ONLY gate. Adding `evaluation` to that row
// must break this test rather than silently admitting a package whose provider
// exposes no evaluation resolver.
test('refuses evaluation for an OpenAI-compatible-primary API provider', () => {
  expect(evaluationMaterialization(apiConfig({ protocol: 'openai-compatible' }))).toBeUndefined();
});

test('grants evaluation to an OpenAI Responses and a Gemini primary', () => {
  expect(evaluationMaterialization(apiConfig({ protocol: 'openai-response' }))?.grantsCapability).toBe(true);
  expect(evaluationMaterialization(apiConfig({ protocol: 'gemini' }))?.grantsCapability).toBe(true);
});

// API convert materializes from the PRIMARY endpoint package only, so an extra
// endpoint that could serve evaluation grants nothing: a convert attempt would
// call the primary package, and inbound System One cannot raw-match the extra.
test('ignores an evaluation-capable extra endpoint on a non-qualifying primary', () => {
  const config = apiConfig({
    protocol: 'openai-compatible',
    endpoints: [{ protocol: 'anthropic', baseURL: 'https://api.anthropic.com' }],
  });

  expect(evaluationMaterialization(config)).toBeUndefined();
});

// The cold-start case. A multi-capability package such as @ai-sdk/gateway stays
// unclassified, so nothing static can say whether it resolves evaluation models.
// The transport must still be attached on a provider whose package has never been
// loaded: treating "not yet probed" as unsupported drops this candidate on the
// first evaluation request of the process.
test('attaches a transport to an unclassified ai-sdk package before anything is probed', async () => {
  let loads = 0;
  const materialized = evaluationMaterialization(aiSdkConfig('@ai-sdk/gateway'), {
    loadProvider: async () => {
      loads += 1;
      return { evaluationModel: () => ({ specificationVersion: 'v4' }) };
    },
  });

  expect(materialized).toBeDefined();
  expect(loads).toBe(0);
  // The grant waits for discovery rather than guessing either way.
  expect(materialized?.grantsCapability).toBe(false);
  expect((await materialized!.transport.discover()).kind).toBe('supported');
});

test('reports a cold package that genuinely lacks evaluation as unsupported, not failed', async () => {
  const materialized = evaluationMaterialization(aiSdkConfig('@ai-sdk/gateway'), {
    loadProvider: async () => ({}),
  });

  expect((await materialized!.transport.discover()).kind).toBe('unsupported');
});

// A bad package name or a missing install is a candidate failure that falls back,
// never a router miss and never a startup failure.
test('reports an uninstallable ai-sdk package as failed', async () => {
  const materialized = evaluationMaterialization(aiSdkConfig('@scope/not-installed'), {
    loadProvider: async () => {
      throw new Error('ProviderNotInstalledError');
    },
  });

  const discovered = await materialized!.transport.discover();
  expect(discovered.kind).toBe('failed');
  expect(discovered.kind === 'failed' && discovered.error.message).toContain('ProviderNotInstalled');
});

test('grants evaluation statically when the classifier pins the package to System One', () => {
  expect(evaluationMaterialization(aiSdkConfig('@ai-sdk/typesafe-ai'))?.grantsCapability).toBe(true);
});

test('routes the provider fetch and endpoint credentials into the evaluation package load', async () => {
  let loaded: { packageName: string; options: Record<string, unknown> } | undefined;
  const fetch = (async () => new Response()) as unknown as ProviderFetch;
  const materialized = evaluationMaterialization(apiConfig({ protocol: 'anthropic', apiKey: 'secret' }), {
    fetch,
    loadProvider: async (packageName, options) => {
      loaded = { packageName, options: options ?? {} };
      return {};
    },
  });

  await materialized!.transport.discover();
  expect(loaded?.packageName).toBe('@ai-sdk/anthropic');
  expect(loaded?.options['baseURL']).toBe('https://api.example.com');
  expect(loaded?.options['apiKey']).toBe('secret');
  expect(loaded?.options['fetch']).toBe(fetch);
});

function materializeOne(provider: Record<string, unknown>) {
  const config = ConfigSchema.parse({ providers: { p: { models: ['judge-1'], ...provider } } });
  return materializeProviders(config).providers[0]!;
}

// Proves `hasEvaluationTransport` actually reaches `buildModelCapabilityIndex`.
// Nothing mechanical reports it going missing: the symptom is a provider that is
// silently never selected for evaluation.
test('an Anthropic API provider reaches the capability index with evaluation granted', () => {
  const instance = materializeOne({ kind: 'api', protocol: 'anthropic', baseURL: 'https://api.anthropic.com' });

  expect(supportsEvaluation(instance.capabilityIndex, 'judge-1')).toBe(true);
  expect(instance.evaluation).toBeDefined();
});

// The cause-side companion. Same model, same shape, a protocol the table
// excludes: the grant must come from the transport flag, never from a
// catalog-absent fallthrough that would pass the test above on its own.
test('an OpenAI-compatible API provider reaches the index without evaluation', () => {
  const instance = materializeOne({ kind: 'api', protocol: 'openai-compatible', baseURL: 'https://api.example.com' });

  expect(supportsEvaluation(instance.capabilityIndex, 'judge-1')).toBe(false);
  expect(instance.evaluation).toBeUndefined();
});

test('an unclassified ai-sdk provider is attached but not granted at materialization', () => {
  const instance = materializeOne({ kind: 'ai-sdk', packageName: '@ai-sdk/gateway' });

  expect(instance.evaluation).toBeDefined();
  expect(supportsEvaluation(instance.capabilityIndex, 'judge-1')).toBe(false);
});
