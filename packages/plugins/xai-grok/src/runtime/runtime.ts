import { createOpenAI } from '@ai-sdk/openai';
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext } from '@aio-proxy/plugin-sdk';

import { createXAIGrokCLIHeaders, XAI_GROK_CLI_BASE_URL } from '../cli-headers/index';
import { currentXAIGrokCredential, type XAIGrokFetch, type XAIGrokOAuthOptions } from '../oauth';
import type { XAIGrokCredential } from '../schema';
import { sanitizeXAIGrokResponsesBody } from './sanitize-responses/index';

type CustomToolCompileContext = { grammarFallbackApplied: boolean };
type OpenAIResponsesModel = ReturnType<ReturnType<typeof createOpenAI>['responses']>;
type OpenAIResponsesCallOptions = Parameters<OpenAIResponsesModel['doStream']>[0];
type OpenAIResponsesStreamPart =
  Awaited<ReturnType<OpenAIResponsesModel['doStream']>> extends {
    stream: ReadableStream<infer T>;
  }
    ? T
    : never;

export async function createXAIGrokRuntime(
  context: RuntimeContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const fetch = options.fetch ?? context.fetch;
  const openai = createOpenAI({
    name: 'xai-grok-oauth',
    baseURL: XAI_GROK_CLI_BASE_URL,
    apiKey: 'dynamic-credential',
    fetch: createXAIGrokDynamicFetch(context.credentials, { ...options, fetch }),
  });
  return {
    provider: {
      specificationVersion: 'v4',
      languageModel: (modelId) => xaiCompatibleResponsesModel(openai.responses(modelId)),
      embeddingModel: () => unsupported('embedding'),
      imageModel: () => unsupported('image generation'),
    },
  };
}

export function createXAIGrokDynamicFetch(
  credentials: CredentialPort<XAIGrokCredential>,
  options: XAIGrokOAuthOptions = {},
): XAIGrokFetch {
  const fetch = options.fetch ?? globalThis.fetch;
  const dynamicFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : options.signal);
    const credential = await currentXAIGrokCredential(credentials, {
      ...options,
      fetch,
      ...(signal === undefined ? {} : { signal }),
    });
    const request = new Request(input, init);
    const headers = createXAIGrokCLIHeaders(credential, request.headers);
    headers.delete('content-length');
    const body = await outgoingBody(request);
    return await fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      redirect: request.redirect,
    });
  };
  return Object.assign(dynamicFetch, { preconnect: globalThis.fetch.preconnect });
}

function xaiCompatibleResponsesModel(model: OpenAIResponsesModel): OpenAIResponsesModel {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const fallback = xaiCustomToolFallback(options);
      warnGrammarFallback(fallback.grammarFallbackApplied);
      const result = await model.doGenerate(fallback.options);
      return {
        ...result,
        content: result.content.map((part) =>
          part.type === 'tool-call' && fallback.toolNames.has(part.toolName)
            ? { ...part, input: customFallbackInput(part.input) }
            : part,
        ),
      };
    },
    async doStream(options) {
      const fallback = xaiCustomToolFallback(options);
      warnGrammarFallback(fallback.grammarFallbackApplied);
      const result = await model.doStream(fallback.options);
      return {
        ...result,
        stream: customFallbackStream(result.stream, fallback.toolNames),
      };
    },
  };
}

function xaiCustomToolFallback(options: OpenAIResponsesCallOptions): {
  readonly options: OpenAIResponsesCallOptions;
  readonly toolNames: ReadonlySet<string>;
  readonly grammarFallbackApplied: boolean;
} {
  const toolNames = new Set<string>();
  let grammarFallbackApplied = false;
  const tools = options.tools?.map((tool) => {
    if (tool.type !== 'provider' || tool.id !== 'openai.custom') return tool;
    toolNames.add(tool.name);
    const format = Reflect.get(tool.args, 'format');
    if (
      typeof format === 'object' &&
      format !== null &&
      Reflect.get(format, 'type') === 'grammar' &&
      (Reflect.get(format, 'syntax') === 'regex' || Reflect.get(format, 'syntax') === 'lark') &&
      typeof Reflect.get(format, 'definition') === 'string'
    ) {
      grammarFallbackApplied = true;
    }
    const description = Reflect.get(tool.args, 'description');
    return {
      type: 'function' as const,
      name: tool.name,
      ...(typeof description === 'string' ? { description } : {}),
      inputSchema: customFallbackSchema,
    };
  });
  if (toolNames.size === 0) return { options, toolNames, grammarFallbackApplied };
  return {
    options: {
      ...options,
      prompt: customFallbackPrompt(options.prompt, toolNames),
      ...(tools === undefined ? {} : { tools }),
    },
    toolNames,
    grammarFallbackApplied,
  };
}

function customFallbackPrompt(
  prompt: OpenAIResponsesCallOptions['prompt'],
  toolNames: ReadonlySet<string>,
): OpenAIResponsesCallOptions['prompt'] {
  return prompt.map((message) => {
    if (message.role !== 'assistant') return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool-call' && toolNames.has(part.toolName) && typeof part.input === 'string'
          ? { ...part, input: { input: part.input } }
          : part,
      ),
    };
  });
}

function customFallbackStream(
  stream: ReadableStream<OpenAIResponsesStreamPart>,
  toolNames: ReadonlySet<string>,
): ReadableStream<OpenAIResponsesStreamPart> {
  const inputs = new Map<string, string>();
  return stream.pipeThrough(
    new TransformStream<OpenAIResponsesStreamPart, OpenAIResponsesStreamPart>({
      transform(part, controller) {
        if (part.type === 'tool-call' && toolNames.has(part.toolName)) {
          controller.enqueue({ ...part, input: customFallbackInput(part.input) });
          return;
        }
        if (part.type === 'tool-input-start' && toolNames.has(part.toolName)) inputs.set(part.id, '');
        else if (part.type === 'tool-input-delta' && inputs.has(part.id)) {
          inputs.set(part.id, `${inputs.get(part.id)}${part.delta}`);
          return;
        } else if (part.type === 'tool-input-end') {
          const input = inputs.get(part.id);
          if (input !== undefined) {
            inputs.delete(part.id);
            controller.enqueue({ type: 'tool-input-delta', id: part.id, delta: customFallbackInput(input) });
          }
        }
        controller.enqueue(part);
      },
    }),
  );
}

function customFallbackInput(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      typeof Reflect.get(parsed, 'input') === 'string'
    ) {
      return JSON.stringify(Reflect.get(parsed, 'input'));
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return value;
}

function warnGrammarFallback(applied: boolean): void {
  if (!applied) return;
  console.warn(
    '[aio-proxy] xAI Grok Responses compatibility downgrade',
    'custom_tool.grammar',
    'function_fallback',
    'provider_lacks_native_grammar',
  );
}

const customFallbackSchema = {
  type: 'object',
  properties: { input: { type: 'string' } },
  required: ['input'],
  additionalProperties: false,
} as const;

function unsupported(surface: string): never {
  throw new Error(`xAI Grok OAuth does not support ${surface}`);
}

async function outgoingBody(request: Request): Promise<BodyInit | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const original = new Uint8Array(await request.arrayBuffer());
  if (!new URL(request.url).pathname.endsWith('/responses')) return new Uint8Array(original);
  const bytes = sanitizeXAIGrokResponsesBody(original);
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null) return new Uint8Array(bytes);
    const compiled = compileCompatibleCustomTools(value);
    return compiled ? JSON.stringify(value) : new Uint8Array(bytes);
  } catch {
    return new Uint8Array(bytes);
  }
}

function compileCompatibleCustomTools(value: object): boolean {
  const context: CustomToolCompileContext = { grammarFallbackApplied: false };
  let changed = false;
  changed = compileToolList(Reflect.get(value, 'tools'), context) || changed;
  const choice = Reflect.get(value, 'tool_choice');
  if (typeof choice === 'object' && choice !== null && Reflect.get(choice, 'type') === 'custom') {
    Reflect.set(choice, 'type', 'function');
    changed = true;
  }
  const input = Reflect.get(value, 'input');
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'object' && item !== null && Reflect.get(item, 'type') === 'additional_tools') {
        changed = compileToolList(Reflect.get(item, 'tools'), context) || changed;
        continue;
      }
      changed = compileHistoryRecord(item) || changed;
    }
  }
  if (context.grammarFallbackApplied) {
    console.warn(
      '[aio-proxy] xAI Grok Responses compatibility downgrade',
      'custom_tool.grammar',
      'function_fallback',
      'provider_lacks_native_grammar',
    );
  }
  return changed;
}

function compileToolList(tools: unknown, context: CustomToolCompileContext): boolean {
  if (!Array.isArray(tools)) return false;
  let changed = false;
  for (const tool of tools) {
    if (typeof tool === 'object' && tool !== null && Reflect.get(tool, 'type') === 'namespace') {
      changed = compileToolList(Reflect.get(tool, 'tools'), context) || changed;
      continue;
    }
    changed = compileCustomDeclaration(tool, context) || changed;
  }
  return changed;
}

function compileCustomDeclaration(tool: unknown, context: CustomToolCompileContext): boolean {
  if (typeof tool !== 'object' || tool === null || Reflect.get(tool, 'type') !== 'custom') return false;
  const format = Reflect.get(tool, 'format');
  if (typeof format === 'object' && format !== null && Reflect.get(format, 'type') === 'grammar') {
    const syntax = Reflect.get(format, 'syntax');
    if ((syntax !== 'regex' && syntax !== 'lark') || typeof Reflect.get(format, 'definition') !== 'string') {
      return false;
    }
    context.grammarFallbackApplied = true;
  }
  if (
    format !== undefined &&
    (typeof format !== 'object' ||
      format === null ||
      (Reflect.get(format, 'type') !== 'text' && Reflect.get(format, 'type') !== 'grammar'))
  ) {
    return false;
  }
  Reflect.set(tool, 'type', 'function');
  Reflect.set(tool, 'parameters', {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  });
  Reflect.deleteProperty(tool, 'format');
  return true;
}

function compileHistoryRecord(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const type = Reflect.get(item, 'type');
  if (type === 'custom_tool_call') {
    const input = Reflect.get(item, 'input');
    if (typeof input !== 'string') return false;
    Reflect.set(item, 'type', 'function_call');
    Reflect.set(item, 'arguments', JSON.stringify({ input }));
    Reflect.deleteProperty(item, 'input');
    return true;
  }
  if (type !== 'custom_tool_call_output') return false;
  Reflect.set(item, 'type', 'function_call_output');
  return true;
}
