import type { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, ModelMessage, TextStreamPart, ToolSet } from "../ai-sdk-bridge";

export type EmptyProtocolContext = Readonly<Record<never, never>>;
export type ModelEventStream = ReadableStream<TextStreamPart<ToolSet>>;

export type ProtocolErrorMapper = Readonly<{
  requestError: (error: unknown) => Response | undefined;
  modelNotFound: (message: string) => Response;
  tooLarge: () => Response;
  unsupported: (feature: string) => Response;
  provider: (error: unknown) => Response | undefined;
}>;

export type ModelInvocation = {
  readonly messages: readonly ModelMessage[];
  readonly settings?: CallSettings;
  readonly tools?: ToolSet;
};

export type ProtocolAdapter<TRequest, TContext> = Readonly<{
  protocol: ProviderProtocol;
  parse: (raw: Request, context: TContext) => Promise<TRequest>;
  model: (request: TRequest, context: TContext) => string;
  variant: (request: TRequest, context: TContext) => string | undefined;
  wantsStream: (request: TRequest, context: TContext) => boolean;
  rawRequest: (raw: Request, request: TRequest, resolvedModel: string, context: TContext) => Promise<Request>;
  modelInvocation: (request: TRequest, context: TContext) => ModelInvocation;
  modelJson: (stream: ModelEventStream) => Promise<unknown>;
  modelSse: (stream: ModelEventStream) => ReadableStream<Uint8Array>;
  errors: ProtocolErrorMapper;
}>;

export type ProtocolAdapterDefinition<TRequest, TContext> = Omit<ProtocolAdapter<TRequest, TContext>, "variant"> & {
  readonly variant?: ProtocolAdapter<TRequest, TContext>["variant"];
};

const noVariant = (): undefined => undefined;

export function defineProtocolAdapter<TRequest, TContext>(
  definition: ProtocolAdapterDefinition<TRequest, TContext>,
): ProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    variant: definition.variant ?? noVariant,
  });
}
