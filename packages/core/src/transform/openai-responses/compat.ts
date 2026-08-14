import type { ModelMessage } from '../../ai-sdk-bridge';
import { OpenAIResponsesTransformError } from '../../error';
import type { OpenAIResponsesInputItem } from '../../ingress/openai-responses/index';
import { inputMessage, toolOutput } from './input-content';
import {
  flattenOpenAIResponsesToolName,
  readOpenAIResponsesWireMetadata,
  rejectOpenAIResponsesFeature,
  warnOpenAIResponsesDegradation,
  wireProviderOptions,
  wireToolCallProviderOptions,
} from './tools';
import type { OpenAIResponsesTransformTool, OpenAIResponsesWireMetadata } from './types';

type AssistantMessage = Extract<ModelMessage, { role: 'assistant' }>;
type AssistantPart = Exclude<AssistantMessage['content'], string>[number];
type ToolMessage = Extract<ModelMessage, { role: 'tool' }>;
type ToolResultPart = Extract<ToolMessage['content'][number], { type: 'tool-result' }>;
type CallIdentity = {
  readonly flattenedName: string;
  readonly metadata?: OpenAIResponsesWireMetadata;
};

type ConvertState = {
  readonly messages: ModelMessage[];
  readonly calls: Map<string, CallIdentity>;
  readonly tools: readonly OpenAIResponsesTransformTool[] | undefined;
  previous: 'call' | 'result' | undefined;
};

type InputItem = OpenAIResponsesInputItem;
type AgentMessageItem = Extract<InputItem, { type: 'agent_message' }>;
type ReasoningItem = Extract<InputItem, { type: 'reasoning' }>;
type FunctionCallItem = Extract<InputItem, { type: 'function_call' }>;
type CustomToolCallItem = Extract<InputItem, { type: 'custom_tool_call' }>;
type ToolCallOutputItem = Extract<InputItem, { type: 'function_call_output' | 'custom_tool_call_output' }>;

export function openAIResponsesInputMessages(
  items: readonly OpenAIResponsesInputItem[],
  tools?: readonly OpenAIResponsesTransformTool[],
): ModelMessage[] {
  const state: ConvertState = { messages: [], calls: new Map(), tools, previous: undefined };

  for (const [index, item] of items.entries()) {
    if ('role' in item && item.type !== 'additional_tools') {
      state.messages.push(inputMessage(item, index));
      state.previous = undefined;
      continue;
    }

    switch (item.type) {
      case 'additional_tools':
        state.previous = undefined;
        break;
      case 'agent_message':
        convertAgentMessage(state, item, index);
        break;
      case 'reasoning':
        convertReasoning(state, item, index);
        break;
      case 'item_reference':
        return rejectOpenAIResponsesFeature(item.type, `input.${index}.type`);
      case '__aio_proxy_unsupported__':
        return rejectOpenAIResponsesFeature(item.wireType, `input.${index}.type`);
      case 'function_call':
        convertFunctionCall(state, item, index);
        break;
      case 'custom_tool_call':
        convertCustomToolCall(state, item, index);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        convertToolCallOutput(state, item, index);
        break;
    }
  }

  return state.messages;
}

function convertAgentMessage(state: ConvertState, item: AgentMessageItem, index: number): void {
  warnOpenAIResponsesDegradation('agent_message.role', `input.${index}.type`, 'converted');
  const text: string[] = [];
  for (const [partIndex, part] of item.content.entries()) {
    if (part.type === 'input_text') {
      text.push(part.text);
    } else {
      warnOpenAIResponsesDegradation(
        'agent_message.encrypted_content',
        `input.${index}.content.${partIndex}.type`,
        'dropped',
      );
    }
  }
  if (text.length > 0) {
    state.messages.push({
      role: 'user',
      content: `[agent ${item.author} -> ${item.recipient}] ${text.join('')}`,
      providerOptions: wireProviderOptions({
        protocol: 'openai-responses',
        inputIndex: index,
        itemType: item.type,
        ...(item.id === undefined ? {} : { itemId: item.id }),
        author: item.author,
        recipient: item.recipient,
      }),
    });
  }
  state.previous = undefined;
}

function convertReasoning(state: ConvertState, item: ReasoningItem, index: number): void {
  if (item.encrypted_content != null) {
    warnOpenAIResponsesDegradation('reasoning.encrypted_content', `input.${index}.encrypted_content`, 'dropped');
  }
  const text = item.summary.map((part) => part.text).join('');
  if (text !== '') {
    warnOpenAIResponsesDegradation('reasoning.summary', `input.${index}.summary`, 'converted');
    const part: AssistantPart = {
      type: 'reasoning',
      text,
      providerOptions: wireProviderOptions({
        protocol: 'openai-responses',
        inputIndex: index,
        itemType: item.type,
        ...(item.id === undefined ? {} : { itemId: item.id }),
        ...(item.status === undefined ? {} : { status: item.status }),
      }),
    };
    state.messages.push({ role: 'assistant', content: [part] });
  }
  state.previous = undefined;
}

function convertFunctionCall(state: ConvertState, item: FunctionCallItem, index: number): void {
  const namespace = item.namespace ?? uniqueToolNamespace(state.tools, item.name, 'function', index, item.type);
  const flattenedName = flattenOpenAIResponsesToolName(namespace, item.name);
  const metadata =
    namespace === undefined && item.id === undefined && item.status === undefined
      ? undefined
      : ({
          protocol: 'openai-responses',
          inputIndex: index,
          itemType: item.type,
          ...(item.id === undefined ? {} : { itemId: item.id }),
          ...(item.status === undefined ? {} : { status: item.status }),
          wireToolType: 'function',
          wireToolName: item.name,
          ...(namespace === undefined ? {} : { namespace }),
        } satisfies OpenAIResponsesWireMetadata);
  state.calls.set(item.call_id, { flattenedName, ...(metadata === undefined ? {} : { metadata }) });
  appendAssistantPart(state.messages, state.previous, {
    type: 'tool-call',
    toolCallId: item.call_id,
    toolName: flattenedName,
    input: parseArguments(item.arguments, `input.${index}.arguments`),
    ...(metadata === undefined ? {} : { providerOptions: wireToolCallProviderOptions(metadata) }),
  });
  state.previous = 'call';
}

function convertCustomToolCall(state: ConvertState, item: CustomToolCallItem, index: number): void {
  const namespace = item.namespace ?? uniqueToolNamespace(state.tools, item.name, 'custom', index, item.type);
  const flattenedName = flattenOpenAIResponsesToolName(namespace, item.name);
  const metadata = {
    protocol: 'openai-responses',
    inputIndex: index,
    itemType: item.type,
    ...(item.id === undefined ? {} : { itemId: item.id }),
    ...(item.status === undefined ? {} : { status: item.status }),
    wireToolType: 'custom',
    wireToolName: item.name,
    ...(namespace === undefined ? {} : { namespace }),
  } satisfies OpenAIResponsesWireMetadata;
  state.calls.set(item.call_id, { flattenedName, metadata });
  appendAssistantPart(state.messages, state.previous, {
    type: 'tool-call',
    toolCallId: item.call_id,
    toolName: flattenedName,
    input: { input: item.input },
    providerOptions: wireToolCallProviderOptions(metadata),
  });
  state.previous = 'call';
}

function uniqueToolNamespace(
  tools: readonly OpenAIResponsesTransformTool[] | undefined,
  wireName: string,
  wireType: 'function' | 'custom',
  index: number,
  itemType: string,
): string | undefined {
  const matches: Array<string | undefined> = [];
  for (const tool of tools ?? []) {
    const metadata = readOpenAIResponsesWireMetadata(tool.metadata);
    if (metadata?.wireToolType !== wireType || metadata.wireToolName !== wireName) continue;
    matches.push(metadata.namespace);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    warnOpenAIResponsesDegradation(`${itemType}.namespace`, `input.${index}.namespace`, 'dropped');
  }
  return undefined;
}

function convertToolCallOutput(state: ConvertState, item: ToolCallOutputItem, index: number): void {
  const call = state.calls.get(item.call_id);
  if (call === undefined) throw new OpenAIResponsesTransformError(`input.${index}.call_id`);
  const custom = item.type === 'custom_tool_call_output';
  const metadata = {
    protocol: 'openai-responses',
    inputIndex: index,
    itemType: item.type,
    ...(item.id === undefined ? {} : { itemId: item.id }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(call.metadata?.wireToolType === undefined ? {} : { wireToolType: call.metadata.wireToolType }),
    ...(call.metadata?.wireToolName === undefined ? {} : { wireToolName: call.metadata.wireToolName }),
    ...(call.metadata?.namespace === undefined ? {} : { namespace: call.metadata.namespace }),
    outputKind: typeof item.output === 'string' ? 'string' : 'content',
  } satisfies OpenAIResponsesWireMetadata;
  const part: ToolResultPart = {
    type: 'tool-result',
    toolCallId: item.call_id,
    toolName: call.flattenedName,
    output: toolOutput(item.output, `input.${index}.output`),
    ...(custom || call.metadata !== undefined ? { providerOptions: wireProviderOptions(metadata) } : {}),
  };
  appendToolResult(state.messages, state.previous, part);
  state.previous = 'result';
}

function appendAssistantPart(messages: ModelMessage[], previous: 'call' | 'result' | undefined, part: AssistantPart) {
  const last = messages.at(-1);
  if (previous === 'call' && last?.role === 'assistant' && typeof last.content !== 'string') {
    messages[messages.length - 1] = { ...last, content: [...last.content, part] };
    return;
  }
  messages.push({ role: 'assistant', content: [part] });
}

function appendToolResult(messages: ModelMessage[], previous: 'call' | 'result' | undefined, part: ToolResultPart) {
  const last = messages.at(-1);
  if (previous === 'result' && last?.role === 'tool') {
    messages[messages.length - 1] = { ...last, content: [...last.content, part] };
    return;
  }
  messages.push({ role: 'tool', content: [part] });
}

function parseArguments(value: string, path: string): unknown {
  if (value === '') return {};
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new OpenAIResponsesTransformError(path);
    throw error;
  }
}
