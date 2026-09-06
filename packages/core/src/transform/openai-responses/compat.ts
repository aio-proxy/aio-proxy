import type { ModelMessage } from '../../ai-sdk-bridge';
import { OpenAIResponsesTransformError } from '../../error';
import type { OpenAIResponsesInputItem } from '../../ingress/openai-responses/index';
import type { ModelInvocationDiagnostic } from '../../protocol/adapter';
import { inputMessage, toolOutput, toolOutputParts } from './input-content';
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
type UserMessage = Extract<ModelMessage, { role: 'user' }>;
type UserPart = Exclude<UserMessage['content'], string>[number];
type ToolMessage = Extract<ModelMessage, { role: 'tool' }>;
type ToolResultPart = Extract<ToolMessage['content'][number], { type: 'tool-result' }>;
type CallIdentity = {
  readonly flattenedName: string;
  readonly metadata?: OpenAIResponsesWireMetadata;
};

type ConvertState = {
  readonly messages: ModelMessage[];
  readonly diagnostics: ModelInvocationDiagnostic[];
  readonly calls: Map<string, CallIdentity>;
  readonly answered: ReadonlySet<string>;
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
): { messages: ModelMessage[]; diagnostics: ModelInvocationDiagnostic[] } {
  const state: ConvertState = {
    messages: [],
    diagnostics: [],
    calls: new Map(),
    answered: answeredCallIds(items),
    tools,
    previous: undefined,
  };

  for (const [index, item] of items.entries()) {
    if (item.type === undefined || item.type === 'message') {
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
      case 'web_search_call':
        if (!canDropCompletedWebSearch(item)) {
          return rejectOpenAIResponsesFeature('web_search_call', `input.${index}.type`);
        }
        state.previous = undefined;
        state.diagnostics.push({
          feature: 'web_search_call',
          action: 'dropped',
          reason: 'completed_without_results_or_sources',
          inputIndex: index,
        });
        break;
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

  return { messages: state.messages, diagnostics: state.diagnostics };
}

// Call ids that a later item answers. Only an output positioned *after* its call
// counts, matching the forward-pass rule convertToolCallOutput applies: an output
// preceding its call is an orphan there, so the call must stay unanswered here
// rather than both sides claiming to be paired.
function answeredCallIds(items: readonly OpenAIResponsesInputItem[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const answered = new Set<string>();
  for (const item of items) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      seen.add(item.call_id);
      continue;
    }
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
    if (item.call_id !== undefined && seen.has(item.call_id)) answered.add(item.call_id);
  }
  return answered;
}

function hasOwnedActionSources(item: Extract<OpenAIResponsesInputItem, { type: 'web_search_call' }>): boolean {
  const action = item.action;
  return typeof action === 'object' && action !== null && Object.hasOwn(action, 'sources');
}

function canDropCompletedWebSearch(item: Extract<OpenAIResponsesInputItem, { type: 'web_search_call' }>): boolean {
  return item.status === 'completed' && !Object.hasOwn(item, 'results') && !hasOwnedActionSources(item);
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
    appendAssistantPart(state.messages, state.previous, part);
  }
  state.previous = undefined;
}

function convertFunctionCall(state: ConvertState, item: FunctionCallItem, index: number): void {
  const namespace = item.namespace ?? uniqueToolNamespace(state.tools, item.name, 'function', index, item.type);
  const flattenedName = flattenOpenAIResponsesToolName(namespace, item.name);
  if (!state.answered.has(item.call_id)) {
    return convertUnansweredToolCall(state, item, index, flattenedName, item.arguments);
  }
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
  if (!state.answered.has(item.call_id)) {
    return convertUnansweredToolCall(state, item, index, flattenedName, item.input);
  }
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

// Narrates a tool call that no output answers, instead of emitting a dangling
// tool-call part. Providers reject an unanswered call (`400 No tool output found
// for function call …` upstream; Anthropic refuses a `tool_use` with no
// `tool_result`), and synthesizing an output — what the Codex client and
// OmniRoute do — invents a tool return the caller never sent. Narrating keeps
// the fact that the call happened without fabricating its result. The arguments
// are carried as the caller wrote them so the text stays byte-stable across
// turns and keeps upstream prefix caching intact.
function convertUnansweredToolCall(
  state: ConvertState,
  item: FunctionCallItem | CustomToolCallItem,
  index: number,
  toolName: string,
  args: string,
): void {
  warnOpenAIResponsesDegradation(`${item.type}.unanswered`, `input.${index}.call_id`, 'converted');
  state.diagnostics.push({
    feature: 'unanswered_tool_call',
    action: 'converted',
    reason: 'call_without_matching_output',
    inputIndex: index,
  });
  appendAssistantPart(state.messages, state.previous, {
    type: 'text',
    text: `[unanswered tool call: ${toolName}(${args})]`,
  });
  // Not registered in state.calls: a later output for this id is an orphan too,
  // and must take the note path rather than pair with a call that is now text.
  state.previous = undefined;
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
  // An absent call_id means the client synthesized this output without a call
  // (see functionCallOutputItemSchema). This candidate cannot pair it with a
  // call, but a same-protocol raw candidate would forward it verbatim, so reject
  // as an unsupported feature and let the pipeline fall back instead of 400ing.
  const callId = item.call_id;
  if (callId === undefined) return rejectOpenAIResponsesFeature(`${item.type}.call_id`, `input.${index}.call_id`);
  const call = state.calls.get(callId);
  // A call_id with no preceding call is an orphan: context compaction can drop
  // the call while keeping its output (Codex's guardian_history truncates
  // between the two). Raw passthrough cannot rescue it either — the Responses
  // API answers `400 No tool call found for function call output` — so fold the
  // output into a user note instead of failing the request.
  if (call === undefined) return convertOrphanToolCallOutput(state, item, index, callId);
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
    toolCallId: callId,
    toolName: call.flattenedName,
    output: toolOutput(item.output, `input.${index}.output`),
    ...(custom || call.metadata !== undefined ? { providerOptions: wireProviderOptions(metadata) } : {}),
  };
  appendToolResult(state.messages, state.previous, part);
  state.previous = 'result';
}

// Preserves an orphan tool output as a user note. A proxy must not decide the
// output is worthless — dropping it (what the Codex client does locally, where
// it owns the history) would silently rewrite the caller's conversation. Text
// and images both survive; only the tool-result framing is lost, because no
// tool-call exists to attach them to.
function convertOrphanToolCallOutput(
  state: ConvertState,
  item: ToolCallOutputItem,
  index: number,
  callId: string,
): void {
  warnOpenAIResponsesDegradation(`${item.type}.orphan`, `input.${index}.call_id`, 'converted');
  state.diagnostics.push({
    feature: 'orphan_tool_call_output',
    action: 'converted',
    reason: 'call_id_without_matching_call',
    inputIndex: index,
  });
  const label = `[orphan tool result; call_id=${callId}]`;
  const parts: UserPart[] =
    typeof item.output === 'string'
      ? [{ type: 'text', text: `${label} ${item.output}` }]
      : [{ type: 'text', text: label }, ...toolOutputParts(item.output, `input.${index}.output`)];
  state.messages.push({
    role: 'user',
    content: parts,
    providerOptions: wireProviderOptions({
      protocol: 'openai-responses',
      inputIndex: index,
      itemType: item.type,
      ...(item.id === undefined ? {} : { itemId: item.id }),
      ...(item.status === undefined ? {} : { status: item.status }),
      outputKind: typeof item.output === 'string' ? 'string' : 'content',
    }),
  });
  state.previous = undefined;
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
