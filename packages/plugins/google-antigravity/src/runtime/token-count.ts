import type { JsonValue, LogicalRequestContext, TokenCountCapability, TokenCountInput } from "@aio-proxy/plugin-sdk";

import { createGoogleGenerativeAI, type GoogleProviderSettings } from "@ai-sdk/google";
import { generateText } from "ai";

import type { CcaTransport } from "./transport";

import { createAntigravityGoogleFetch } from "./google-fetch";
import { takeAioProxyOptions } from "./private-options";

const placeholderCredential = "dynamic-oauth-credential";

type CountFetchOptions = {
  readonly context: LogicalRequestContext;
  readonly invocation: TokenCountInput["invocation"];
  readonly modelId: string;
  readonly modelMetadata?: JsonValue;
  readonly transport: CcaTransport;
};

export function createAntigravityTokenCount(
  transport: CcaTransport,
  modelMetadata?: (modelId: string) => JsonValue | undefined,
): TokenCountCapability {
  return {
    async countTokens({ context, invocation, modelId, request }) {
      const split = splitInvocation(context, invocation);
      const metadata = modelMetadata?.(modelId);
      const google = createGoogleGenerativeAI({
        apiKey: placeholderCredential,
        fetch: createCountFetch({
          context,
          invocation,
          modelId,
          transport,
          ...(metadata === undefined ? {} : { modelMetadata: metadata }),
        }),
      });
      const result = await generateText({
        ...split.settings,
        model: google.languageModel(modelId),
        messages: [...invocation.messages],
        ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
        abortSignal: request.signal,
      });
      return { inputTokens: result.usage.inputTokens ?? 0 };
    },
  };
}

export function createCountFetch(options: CountFetchOptions): NonNullable<GoogleProviderSettings["fetch"]> {
  const split = splitInvocation(options.context, options.invocation);
  return createAntigravityGoogleFetch(
    {
      context: options.context,
      ...(options.modelMetadata === undefined ? {} : { modelMetadata: options.modelMetadata }),
      ...(options.invocation.providerTools === undefined ? {} : { providerTools: options.invocation.providerTools }),
      ...(split.privateOptions.thinking === undefined ? {} : { thinking: split.privateOptions.thinking }),
      transport: countTransport(options.transport),
    },
    options.modelId,
  );
}

function countTransport(transport: CcaTransport): CcaTransport {
  return {
    async execute(input) {
      const response = await transport.execute({ ...input, operation: "countTokens", stream: false });
      if (!response.ok) return response;
      const payload: unknown = await response.json();
      const totalTokens = tokenCount(payload);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      return Response.json(
        {
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: totalTokens,
              candidatesTokenCount: 0,
              totalTokenCount: totalTokens,
            },
          },
        },
        { headers, status: response.status, statusText: response.statusText },
      );
    },
  };
}

function tokenCount(payload: unknown): number {
  const value =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? Reflect.get(payload, "totalTokens")
      : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Google Antigravity returned an invalid token count");
  }
  return value;
}

function splitInvocation(context: LogicalRequestContext, invocation: TokenCountInput["invocation"]) {
  const settings = invocation.settings as
    | (NonNullable<TokenCountInput["invocation"]["settings"]> & {
        readonly providerOptions?: Parameters<typeof takeAioProxyOptions>[0];
      })
    | undefined;
  const providerOptions = settings?.providerOptions;
  const aioProxy = record(Reflect.get(providerOptions ?? {}, "aioProxy"));
  const split = takeAioProxyOptions({
    ...providerOptions,
    aioProxy: {
      ...aioProxy,
      logicalRequest: context,
    },
  } as Parameters<typeof takeAioProxyOptions>[0]);
  return {
    privateOptions: split.privateOptions,
    settings: { ...settings, providerOptions: split.providerOptions },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
