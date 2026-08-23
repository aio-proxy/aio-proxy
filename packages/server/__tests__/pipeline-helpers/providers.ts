import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { aioHome, type ModelEventStream, Router } from '@aio-proxy/core';
import { ConfigSchema, type Config, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { LogicalSessionStore } from '../../src/logical-session-store';
import { ProviderCooldownStore } from '../../src/routes/pipeline/provider-cooldown';
import type { ModelTransport, ProviderRouteSource, RawTransport, RuntimeProviderInstance } from '../../src/runtime';
import {
  createUsageCapture,
  type PassthroughUsageOptions,
  type StreamUsageOptions,
  type UsageCapture,
  type UsageCompletion,
} from '../../src/usage-capture';
import { createRecording } from './recording';
import { type FakeProvider, REQUESTED_MODEL } from './types';

// Usage pricing resolves through getProviders()'s file cache rather than an
// injected catalog, so an unseeded harness would reach models.dev over the
// network and leave stream completions unsettled. Seed an empty provider map
// synchronously: lookups miss locally and pricing settles without I/O. Write
// once per home, and rename into place so a concurrent reader never observes a
// partially written file.
const seededHomes = new Set<string>();
function seedEmptyPriceCatalog(): void {
  const home = aioHome();
  if (seededHomes.has(home)) return;
  seededHomes.add(home);
  const cacheDir = join(home, 'tmp', 'cache-storage');
  mkdirSync(cacheDir, { recursive: true });
  const target = join(cacheDir, `${encodeURIComponent('models-dev-providers')}.json`);
  const staging = `${target}.${process.pid}.staging`;
  writeFileSync(
    staging,
    JSON.stringify({ value: { openrouter: { models: {} } }, updatedAt: new Date().toISOString() }),
  );
  renameSync(staging, target);
}

export function rawProvider(options: {
  readonly id: string;
  readonly invoke?: RawTransport['invoke'];
  readonly model?: {
    readonly ensureAvailable?: () => Promise<void>;
    readonly invoke: ModelTransport['invoke'];
  };
  readonly modelId?: string;
  readonly protocol?: ProviderProtocol;
  readonly priority?: number;
  readonly weight?: number;
}): FakeProvider {
  const calls = providerCalls();
  const protocol = options.protocol ?? ProviderProtocol.OpenAICompatible;
  const rawInvoke: RawTransport['invoke'] = async (request, context, transportOptions) => {
    calls.raw.push(request);
    return options.invoke?.(request, context, transportOptions) ?? Response.json({ provider: options.id });
  };
  const model = options.model === undefined ? undefined : instrumentModel(options.model, calls);
  const provider = {
    alias: routeAlias(options.modelId ?? `${options.id}-model`),
    baseURL: `https://${options.id}.example.test/v1`,
    enabled: true,
    id: options.id,
    kind: ProviderKind.Api,
    passthrough: rawInvoke,
    protocol,
    raw: { resolve: ({ protocol: inbound }) => (inbound === protocol ? { invoke: rawInvoke } : undefined) },
    ...(model === undefined ? {} : { model }),
    ...routingFields(options),
  } satisfies RuntimeProviderInstance;
  return { calls, provider };
}

export function modelProvider(options: {
  readonly ensureAvailable?: () => Promise<void>;
  readonly id: string;
  readonly invoke: ModelTransport['invoke'];
  readonly modelId?: string;
  readonly targetProtocol?: ProviderProtocol;
  readonly priority?: number;
  readonly weight?: number;
}): FakeProvider {
  const calls = providerCalls();
  const model = instrumentModel(options, calls);
  const provider = {
    alias: routeAlias(options.modelId ?? `${options.id}-model`),
    enabled: true,
    id: options.id,
    invoke: model.invoke,
    kind: ProviderKind.AiSdk,
    ...(model.ensureAvailable === undefined ? {} : { ensureAvailable: model.ensureAvailable }),
    model,
    ...routingFields(options),
  } satisfies RuntimeProviderInstance;
  return { calls, provider };
}

export function defineProviderRouteSource(
  fixtures: readonly FakeProvider[],
  immediateStreamCompletion?: UsageCompletion,
  debugLogging?: boolean,
  routing: { readonly config?: Config; readonly random?: () => number } = {},
) {
  const providers = fixtures.map((fixture) => fixture.provider);
  const recording = createRecording();
  seedEmptyPriceCatalog();
  const realUsageCapture = createUsageCapture();
  const usage = {
    capturedStreams: [] as ModelEventStream[],
    passthrough: [] as PassthroughUsageOptions[],
    stream: [] as StreamUsageOptions[],
  };
  const logs: unknown[] = [];
  const usageCapture: UsageCapture = {
    passthrough(options) {
      usage.passthrough.push(options);
      return {
        value: options.response,
        completion: Promise.resolve({ outcome: 'success', statusCode: options.response.status }),
      };
    },
    stream(options) {
      usage.stream.push(options);
      const captured =
        immediateStreamCompletion === undefined
          ? realUsageCapture.stream(options)
          : { value: options.stream, completion: Promise.resolve(immediateStreamCompletion) };
      usage.capturedStreams.push(captured.value);
      return captured;
    },
  };
  const config = routing.config;
  const router = new Router(providers, {
    ...(config === undefined ? {} : { models: config.router.models }),
    random: routing.random ?? (() => 0),
  });
  const snapshot = {
    providers,
    router,
    ...(config === undefined ? {} : { config }),
  };
  const source = {
    acquireProviderSnapshot: () => ({
      snapshot,
      release() {},
    }),
    cooldown: new ProviderCooldownStore(),
    currentProviderSnapshot: () => snapshot,
    ...(debugLogging === undefined ? {} : { debugLogging }),
    logger: (entry) => logs.push(entry),
    logicalSessionStore: new LogicalSessionStore(),
    requestRecorder: recording.recorder,
    usageCapture,
  } satisfies ProviderRouteSource;
  return { logs, recording, source, usage };
}

function providerCalls(): FakeProvider['calls'] {
  return { ensure: 0, model: [], raw: [] };
}

function _finishPart(): ModelPart {
  return {
    type: 'finish',
    finishReason: 'stop',
    rawFinishReason: 'stop',
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 },
      inputTokens: 0,
      outputTokenDetails: { reasoningTokens: 0, textTokens: 0 },
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

function instrumentModel(
  model: {
    readonly ensureAvailable?: () => Promise<void>;
    readonly invoke: ModelTransport['invoke'];
    readonly targetProtocol?: ProviderProtocol;
  },
  calls: FakeProvider['calls'],
): ModelTransport {
  return {
    ...(model.ensureAvailable === undefined
      ? {}
      : {
          async ensureAvailable() {
            calls.ensure += 1;
            await model.ensureAvailable?.();
          },
        }),
    ...(model.targetProtocol === undefined ? {} : { targetProtocol: () => model.targetProtocol }),
    invoke(request) {
      calls.model.push(request);
      return model.invoke(request);
    },
  };
}

function routeAlias(model: string) {
  return { [REQUESTED_MODEL]: { model, preserve: false } };
}

function routingFields(options: { readonly priority?: number; readonly weight?: number }) {
  return {
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.weight === undefined ? {} : { weight: options.weight }),
  };
}

export function withSnapshotConfigs(
  source: ProviderRouteSource,
  acquired: Config,
  current = acquired,
): ProviderRouteSource {
  const snapshot = source.currentProviderSnapshot();
  return {
    ...source,
    acquireProviderSnapshot: () => ({ snapshot: { ...snapshot, config: acquired }, release() {} }),
    currentProviderSnapshot: () => ({ ...snapshot, config: current }),
  };
}

export function retryConfig(overrides: Partial<Config['server']['retry']> = {}): Config {
  const base = ConfigSchema.parse({ server: {}, providers: {} });
  return { ...base, server: { ...base.server, retry: { ...base.server.retry, ...overrides } } };
}
