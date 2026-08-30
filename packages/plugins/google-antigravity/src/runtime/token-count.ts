import { createGoogleGenerativeAI, type GoogleProviderSettings } from '@ai-sdk/google';
import type {
  JsonValue,
  LogicalRequestContext,
  ModelCatalog,
  TokenCountCapability,
  TokenCountInput,
} from '@aio-proxy/plugin-sdk';
import { generateText } from 'ai';
import { isPlainObject } from 'es-toolkit/predicate';

import { bindAntigravityThinking } from '../protocol/thinking';
import { createAntigravityGoogleFetch } from './google-fetch';
import { synthesizeThinking } from './google-model';
import { takeAioProxyOptions } from './private-options';
import type { CcaTransport } from './transport';

const placeholderCredential = 'dynamic-oauth-credential';

type CountFetchOptions = {
  readonly catalog?: ModelCatalog;
  readonly context: LogicalRequestContext;
  readonly invocation: TokenCountInput['invocation'];
  readonly modelId: string;
  readonly modelMetadata?: JsonValue;
  readonly thinkingBinder?: ReturnType<typeof bindAntigravityThinking>;
  readonly transport: CcaTransport;
};

export function createAntigravityTokenCount(
  transport: CcaTransport,
  modelMetadata?: (modelId: string) => JsonValue | undefined,
  catalog?: ModelCatalog,
): TokenCountCapability {
  const thinkingBinder = bindAntigravityThinking(catalog);
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
          thinkingBinder,
          ...(catalog === undefined ? {} : { catalog }),
          ...(metadata === undefined ? {} : { modelMetadata: metadata }),
        }),
      });
      const result = await generateText({
        ...split.settings,
        model: google.languageModel(modelId),
        messages: [...invocation.messages],
        ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
        abortSignal: request.signal,
      } as Parameters<typeof generateText>[0]);
      return { inputTokens: result.usage.inputTokens ?? 0 };
    },
  };
}

export function createCountFetch(options: CountFetchOptions): NonNullable<GoogleProviderSettings['fetch']> {
  const split = splitInvocation(options.context, options.invocation);
  return createAntigravityGoogleFetch(
    {
      context: options.context,
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      ...(options.modelMetadata === undefined ? {} : { modelMetadata: options.modelMetadata }),
      ...(options.invocation.providerTools === undefined ? {} : { providerTools: options.invocation.providerTools }),
      ...(split.privateOptions.thinking === undefined ? {} : { thinking: split.privateOptions.thinking }),
      ...(options.thinkingBinder === undefined ? {} : { thinkingBinder: options.thinkingBinder }),
      transport: countTransport(options.transport),
    },
    options.modelId,
  );
}

function countTransport(transport: CcaTransport): CcaTransport {
  return {
    async execute(input) {
      const response = await transport.execute({ ...input, operation: 'countTokens', stream: false });
      if (!response.ok) return response;
      const payload: unknown = await response.json();
      const totalTokens = tokenCount(payload);
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.set('content-type', 'application/json');
      return Response.json(
        {
          response: {
            candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
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
  const value = isPlainObject(payload) ? Reflect.get(payload, 'totalTokens') : undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError('Google Antigravity returned an invalid token count');
  }
  return value;
}

function splitInvocation(context: LogicalRequestContext, invocation: TokenCountInput['invocation']) {
  const settings = invocation.settings as
    | (NonNullable<TokenCountInput['invocation']['settings']> & {
        readonly providerOptions?: Parameters<typeof takeAioProxyOptions>[0];
      })
    | undefined;
  const providerOptions = settings?.providerOptions;
  const aioProxy = record(Reflect.get(providerOptions ?? {}, 'aioProxy'));
  const split = takeAioProxyOptions({
    ...providerOptions,
    aioProxy: {
      ...aioProxy,
      logicalRequest: context,
    },
  } as Parameters<typeof takeAioProxyOptions>[0]);
  const thinking = synthesizeThinking(
    split.privateOptions.thinking,
    settings === undefined ? undefined : Reflect.get(settings, 'reasoning'),
  );
  return {
    privateOptions: {
      ...split.privateOptions,
      ...(thinking === undefined ? {} : { thinking }),
    },
    settings: { ...settings, reasoning: 'provider-default', providerOptions: split.providerOptions },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return isPlainObject(value) ? value : {};
}
