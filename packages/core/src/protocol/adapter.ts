import type { ProviderExecutedTool } from "@aio-proxy/plugin-sdk";
import type { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, ModelMessage, TextStreamPart, ToolSet } from "../ai-sdk-bridge";
import type { ProtocolSessionHints } from "./session";

export type EmptyProtocolContext = Readonly<Record<never, never>>;
export type ModelEventStream = ReadableStream<TextStreamPart<ToolSet>>;

export type ProtocolErrorMapper = Readonly<{
  requestError: (error: unknown) => Response | undefined;
  modelUnsupported?: (error: unknown) => Response | undefined;
  modelNotFound: (message: string) => Response;
  tooLarge: () => Response;
  unsupportedContentEncoding: () => Response;
  unsupported: (feature: string) => Response;
  provider: (error: unknown) => Response | undefined;
}>;

export type ModelInvocation = {
  readonly messages: readonly ModelMessage[];
  readonly settings?: CallSettings;
  readonly tools?: ToolSet;
  readonly providerTools?: readonly ProviderExecutedTool[];
};

export type ModelEgressContext = {
  readonly modelId: string;
  readonly onResponseId?: (responseId: string) => void;
};

export type ProtocolRequestDiagnostic = Readonly<{
  feature: "background";
  action: "dropped";
  effectiveMode: "synchronous";
}>;

export type ProtocolAdapter<TRequest, TContext> = Readonly<{
  protocol: ProviderProtocol;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  variant: (request: TRequest, context: TContext) => string | undefined;
  requestDiagnostics: (request: TRequest, context: TContext) => readonly ProtocolRequestDiagnostic[];
  session?: (request: TRequest, context: TContext) => ProtocolSessionHints;
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (raw: Request, request: TRequest, resolvedModel: string, context: TContext) => Promise<Request>;
  modelInvocation: (request: TRequest, context: TContext) => ModelInvocation;
  modelJson: (stream: ModelEventStream, context: ModelEgressContext) => Promise<unknown>;
  modelSse: (stream: ModelEventStream, context: ModelEgressContext) => ReadableStream<Uint8Array>;
  errors: ProtocolErrorMapper;
}>;

export type ProtocolAdapterDefinition<TRequest, TContext> = Omit<
  ProtocolAdapter<TRequest, TContext>,
  "requestDiagnostics" | "variant"
> & {
  readonly variant?: ProtocolAdapter<TRequest, TContext>["variant"];
  readonly requestDiagnostics?: ProtocolAdapter<TRequest, TContext>["requestDiagnostics"];
};

const noVariant = (): undefined => undefined;
const noRequestDiagnostics = (): readonly ProtocolRequestDiagnostic[] => [];

export function defineProtocolAdapter<TRequest, TContext>(
  definition: ProtocolAdapterDefinition<TRequest, TContext>,
): ProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    variant: definition.variant ?? noVariant,
    requestDiagnostics: definition.requestDiagnostics ?? noRequestDiagnostics,
  });
}
