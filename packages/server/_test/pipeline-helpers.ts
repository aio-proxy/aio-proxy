import {
  defineProtocolAdapter as defineCoreProtocolAdapter,
  type ModelEventStream,
  Router,
  type TextStreamPart,
  type ToolSet,
} from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import type { RequestAttemptInput, RequestFinishInput, RequestRecorder, RequestSession } from "../src/request-recorder";
import type { ModelTransport, ProviderRouteSource, RawTransport, RuntimeProviderInstance } from "../src/runtime";
import type { PassthroughUsageOptions, StreamUsageOptions, UsageCapture, UsageCompletion } from "../src/usage-capture";

export const REQUESTED_MODEL = "test-model";

type ModelPart = TextStreamPart<ToolSet>;
type ModelCall = Parameters<ModelTransport["invoke"]>[0];

export type TestProtocolRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly stream: boolean;
};

export type TestProtocolContext = {
  modelInvocationCalls: number;
  parseCalls: number;
  rawRequestCalls: number;
};

export type FakeProvider = {
  readonly calls: {
    ensure: number;
    model: ModelCall[];
    raw: Request[];
  };
  readonly provider: RuntimeProviderInstance;
};

export type Recording = {
  readonly begins: Parameters<RequestRecorder["begin"]>[0][];
  readonly attempts: RequestAttemptInput[];
  readonly finals: RequestFinishInput[];
};

export function createProtocolContext(): TestProtocolContext {
  return { modelInvocationCalls: 0, parseCalls: 0, rawRequestCalls: 0 };
}

export function defineProtocolAdapter(protocol: ProviderProtocol = ProviderProtocol.OpenAICompatible) {
  return defineCoreProtocolAdapter<TestProtocolRequest, TestProtocolContext>({
    protocol,
    async parse(raw, context) {
      context.parseCalls += 1;
      const value: unknown = await raw.clone().json();
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("model" in value) ||
        typeof value.model !== "string"
      ) {
        throw new SyntaxError("invalid test request");
      }
      return {
        model: value.model,
        prompt: "prompt" in value && typeof value.prompt === "string" ? value.prompt : "ping",
        stream: "stream" in value && value.stream === true,
      };
    },
    model: (request) => request.model,
    wantsStream: (request) => request.stream,
    async rawRequest(raw, request, resolvedModel, context) {
      context.rawRequestCalls += 1;
      const headers = new Headers(raw.headers);
      headers.delete("content-length");
      return new Request(raw, {
        body: JSON.stringify({ ...request, model: resolvedModel }),
        headers,
      });
    },
    modelInvocation(request, context) {
      context.modelInvocationCalls += 1;
      return { messages: [{ role: "user", content: request.prompt }] };
    },
    async modelJson(stream) {
      return { output: await streamText(stream) };
    },
    modelSse(stream) {
      const encoder = new TextEncoder();
      return stream.pipeThrough(
        new TransformStream<ModelPart, Uint8Array>({
          transform(part, controller) {
            if (part.type === "text-delta") {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: part.text })}\n\n`));
            }
          },
        }),
      );
    },
    errors: {
      requestError: (error) =>
        error instanceof SyntaxError ? errorResponse(400, "request_error", "Invalid test request") : undefined,
      modelNotFound: (message) => errorResponse(404, "model_not_found", message),
      tooLarge: () => errorResponse(413, "too_large", "Request body too large"),
      unsupported: (feature) => errorResponse(501, "unsupported", feature),
      provider: (error) => (error instanceof Error ? errorResponse(502, "provider_error", error.message) : undefined),
    },
  });
}

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
  const rawInvoke: RawTransport["invoke"] = async (request) => {
    calls.raw.push(request);
    return options.invoke?.(request) ?? Response.json({ provider: options.id });
  };
  const model = options.model === undefined ? undefined : instrumentModel(options.model, calls);
  const provider = {
    alias: routeAlias(options.modelId ?? `${options.id}-model`),
    baseUrl: `https://${options.id}.example.test/v1`,
    enabled: true,
    id: options.id,
    kind: ProviderKind.Api,
    passthrough: rawInvoke,
    protocol,
    raw: { invoke: rawInvoke, protocol },
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

export function defineProviderRouteSource(fixtures: readonly FakeProvider[]) {
  const providers = fixtures.map((fixture) => fixture.provider);
  const recording = createRecording();
  const usage = {
    passthrough: [] as PassthroughUsageOptions[],
    stream: [] as StreamUsageOptions[],
  };
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
      return { value: options.stream, completion: Promise.resolve({ outcome: "success" }) };
    },
  };
  const source = {
    currentProviderSnapshot: () => ({ providers, router: new Router(providers) }),
    requestRecorder: recording.recorder,
    usageCapture,
  } satisfies ProviderRouteSource;
  return { recording, source, usage };
}

export function jsonRequest(
  body: unknown,
  options: { readonly contentLength?: number; readonly signal?: AbortSignal } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.contentLength !== undefined) {
    headers.set("content-length", String(options.contentLength));
  }
  return new Request("http://localhost/v1/test", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
    method: "POST",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export function textStream(text: string): ModelEventStream {
  return new ReadableStream<ModelPart>({
    start(controller) {
      controller.enqueue({ type: "text-delta", id: "text-1", text });
      controller.close();
    },
  });
}

export function errorStream(error: unknown): ModelEventStream {
  return new ReadableStream<ModelPart>({
    start(controller) {
      controller.error(error);
    },
  });
}

export function textThenErrorStream(text: string, error: unknown): ModelEventStream {
  let first = true;
  return new ReadableStream<ModelPart>({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue({ type: "text-delta", id: "text-1", text });
        return;
      }
      controller.error(error);
    },
  });
}

export async function settleRecording(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function providerCalls(): FakeProvider["calls"] {
  return { ensure: 0, model: [], raw: [] };
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

function createRecording(): Recording & { readonly recorder: RequestRecorder } {
  const begins: Recording["begins"] = [];
  const attempts: RequestAttemptInput[] = [];
  const finals: RequestFinishInput[] = [];
  const recorder: RequestRecorder = {
    begin(input) {
      begins.push(input);
      let finished = false;
      const session: RequestSession = {
        requestId: `request-${begins.length}`,
        attempt(attempt) {
          if (!finished) attempts.push(attempt);
        },
        finish(finish) {
          if (finished) return;
          finished = true;
          if (finish.attempt !== undefined) attempts.push(finish.attempt);
          finals.push(finish);
        },
        finishFrom(attempt, completion) {
          void completion.then(
            (terminal) => finishFromTerminal(session, attempt, terminal),
            () =>
              session.finish({
                attempt: { ...attempt, outcome: "failure" },
                finalModelId: attempt.modelId,
                finalProviderId: attempt.providerId,
                outcome: "failure",
              }),
          );
        },
      };
      return session;
    },
  };
  return { attempts, begins, finals, recorder };
}

function finishFromTerminal(
  session: RequestSession,
  attempt: Omit<RequestAttemptInput, "errorCode" | "outcome" | "statusCode">,
  terminal: UsageCompletion,
): void {
  const statusCode = "statusCode" in terminal ? terminal.statusCode : undefined;
  const errorCode = terminal.outcome === "failure" ? terminal.errorCode : undefined;
  session.finish({
    attempt: {
      ...attempt,
      outcome: terminal.outcome,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(errorCode === undefined ? {} : { errorCode }),
    },
    finalModelId: attempt.modelId,
    finalProviderId: attempt.providerId,
    ...(statusCode === undefined ? {} : { finalStatusCode: statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
    outcome: terminal.outcome,
    ...(terminal.outcome === "success" && terminal.usage !== undefined ? { usage: terminal.usage } : {}),
  });
}

async function streamText(stream: ModelEventStream): Promise<string> {
  let text = "";
  for await (const part of stream) {
    if (part.type === "text-delta") text += part.text;
  }
  return text;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
