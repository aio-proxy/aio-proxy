import { type ModelEventStream, Router } from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { LogicalSessionStore } from "../../src/logical-session-store";
import type { ModelTransport, ProviderRouteSource, RawTransport, RuntimeProviderInstance } from "../../src/runtime";
import {
  createUsageCapture,
  type PassthroughUsageOptions,
  type StreamUsageOptions,
  type UsageCapture,
  type UsageCompletion,
} from "../../src/usage-capture";
import { createRecording } from "./recording";
import { type FakeProvider, REQUESTED_MODEL } from "./types";

export function rawProvider(options: {
  readonly id: string;
  readonly invoke?: RawTransport["invoke"];
  readonly model?: {
    readonly ensureAvailable?: () => Promise<void>;
    readonly invoke: ModelTransport["invoke"];
  };
  readonly modelId?: string;
  readonly protocol?: ProviderProtocol;
}): FakeProvider {
  const calls = providerCalls();
  const protocol = options.protocol ?? ProviderProtocol.OpenAICompatible;
  const rawInvoke: RawTransport["invoke"] = async (request, context) => {
    calls.raw.push(request);
    return options.invoke?.(request, context) ?? Response.json({ provider: options.id });
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
  } satisfies RuntimeProviderInstance;
  return { calls, provider };
}

export function modelProvider(options: {
  readonly ensureAvailable?: () => Promise<void>;
  readonly id: string;
  readonly invoke: ModelTransport["invoke"];
  readonly modelId?: string;
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
  } satisfies RuntimeProviderInstance;
  return { calls, provider };
}

export function defineProviderRouteSource(
  fixtures: readonly FakeProvider[],
  immediateStreamCompletion?: UsageCompletion,
) {
  const providers = fixtures.map((fixture) => fixture.provider);
  const recording = createRecording();
  const realUsageCapture = createUsageCapture({ priceCatalogTask: async () => undefined });
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
        completion: Promise.resolve({ outcome: "success", statusCode: options.response.status }),
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
  const source = {
    acquireProviderSnapshot: () => ({
      snapshot: { providers, router: new Router(providers) },
      release() {},
    }),
    currentProviderSnapshot: () => ({ providers, router: new Router(providers) }),
    logger: (entry) => logs.push(entry),
    logicalSessionStore: new LogicalSessionStore(),
    requestRecorder: recording.recorder,
    usageCapture,
  } satisfies ProviderRouteSource;
  return { logs, recording, source, usage };
}

function providerCalls(): FakeProvider["calls"] {
  return { ensure: 0, model: [], raw: [] };
}

function _finishPart(): ModelPart {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
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
    readonly invoke: ModelTransport["invoke"];
  },
  calls: FakeProvider["calls"],
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
    invoke(request) {
      calls.model.push(request);
      return model.invoke(request);
    },
  };
}

function routeAlias(model: string) {
  return { [REQUESTED_MODEL]: { model, preserve: false } };
}
