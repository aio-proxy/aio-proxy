import { isPlainObject } from 'es-toolkit/predicate';

import type { ModelMessage } from '../../ai-sdk-bridge';
import { GeminiInteractionsTransformError } from '../../error';
import type { GeminiInteractionsBody, GeminiInteractionsRequest } from '../../ingress/gemini-interactions/index';

type AssistantMessage = Extract<ModelMessage, { role: 'assistant' }>;
type ToolMessage = Extract<ModelMessage, { role: 'tool' }>;
type ToolResultOutput = Extract<ToolMessage['content'][number], { type: 'tool-result' }>['output'];

const STEP_TYPES = new Set(['user_input', 'model_output', 'thought', 'function_call', 'function_result']);

export function geminiInteractionsInputToMessages(request: GeminiInteractionsRequest): readonly ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (request.body.system_instruction !== undefined) {
    messages.push({ role: 'system', content: request.body.system_instruction });
  }
  messages.push(...transcriptMessages(request.body.input));
  if (messages.length === 0) throw new GeminiInteractionsTransformError('input');
  return messages;
}

function transcriptMessages(input: GeminiInteractionsBody['input']): readonly ModelMessage[] {
  if (typeof input === 'string') return input === '' ? [] : [{ role: 'user', content: input }];
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    if (input.every(isStep)) return stepMessages(input);
    const text = textFromContents(input);
    return text === undefined ? [] : [userTextMessage(text)];
  }
  const text = textFromContents([input]);
  return text === undefined ? [] : [userTextMessage(text)];
}

type ToolCallPart = Extract<AssistantMessage['content'], readonly unknown[]>[number] & { type: 'tool-call' };
type ToolResultPart = Extract<ToolMessage['content'][number], { type: 'tool-result' }>;

function stepMessages(steps: readonly unknown[]): readonly ModelMessage[] {
  const toolNames = new Map<string, string>();
  const messages: ModelMessage[] = [];
  let previous: 'call' | 'result' | undefined;
  for (const step of steps) {
    if (!isPlainObject(step)) continue;
    if (step['type'] === 'function_call') {
      appendAssistantToolCall(messages, previous, functionCallPart(step, toolNames));
      previous = 'call';
      continue;
    }
    if (step['type'] === 'function_result') {
      appendToolResult(messages, previous, functionResultPart(step, toolNames));
      previous = 'result';
      continue;
    }
    if (previous === 'call' && (step['type'] === 'model_output' || step['type'] === 'thought')) {
      appendPendingCallContent(messages, step);
      continue;
    }
    previous = undefined;
    const message = stepMessage(step);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

function stepMessage(step: Record<string, unknown>): ModelMessage | undefined {
  switch (step['type']) {
    case 'user_input': {
      const text = textFromContents(step['content']);
      return text === undefined ? undefined : userTextMessage(text);
    }
    case 'model_output': {
      const text = textFromContents(step['content']);
      return text === undefined ? undefined : { role: 'assistant', content: text };
    }
    case 'thought': {
      const text = textFromContents(step['summary']);
      if (text === undefined) return undefined;
      return { role: 'assistant', content: [{ type: 'reasoning', text }] } satisfies AssistantMessage;
    }
    default:
      return undefined;
  }
}

function functionCallPart(step: Record<string, unknown>, toolNames: Map<string, string>): ToolCallPart {
  const id = typeof step['id'] === 'string' ? step['id'] : '';
  const name = typeof step['name'] === 'string' ? step['name'] : '';
  if (id !== '') toolNames.set(id, name);
  return { type: 'tool-call', toolCallId: id, toolName: name, input: step['arguments'] ?? {} };
}

function functionResultPart(step: Record<string, unknown>, toolNames: Map<string, string>): ToolResultPart {
  const callId = typeof step['call_id'] === 'string' ? step['call_id'] : '';
  const name = toolNames.get(callId) ?? '';
  return {
    type: 'tool-result',
    toolCallId: callId,
    toolName: name,
    output: toolOutput(step['result']),
  };
}

function appendPendingCallContent(messages: ModelMessage[], step: Record<string, unknown>): void {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return;
  const text = step['type'] === 'thought' ? textFromContents(step['summary']) : textFromContents(step['content']);
  if (text === undefined) return;
  const part = step['type'] === 'thought' ? { type: 'reasoning' as const, text } : { type: 'text' as const, text };
  messages[messages.length - 1] = { ...last, content: [...last.content, part] };
}

function appendAssistantToolCall(
  messages: ModelMessage[],
  previous: 'call' | 'result' | undefined,
  part: ToolCallPart,
): void {
  const last = messages.at(-1);
  if (previous === 'call' && last?.role === 'assistant' && Array.isArray(last.content)) {
    messages[messages.length - 1] = { ...last, content: [...last.content, part] };
    return;
  }
  messages.push({ role: 'assistant', content: [part] } satisfies AssistantMessage);
}

function appendToolResult(
  messages: ModelMessage[],
  previous: 'call' | 'result' | undefined,
  part: ToolResultPart,
): void {
  const last = messages.at(-1);
  if (previous === 'result' && last?.role === 'tool') {
    messages[messages.length - 1] = { ...last, content: [...last.content, part] };
    return;
  }
  messages.push({ role: 'tool', content: [part] } satisfies ToolMessage);
}

function userTextMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function textFromContents(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (value === undefined) return undefined;
  const parts = Array.isArray(value) ? value : [value];
  const texts = parts.flatMap((part) => {
    if (!isPlainObject(part) || typeof part['text'] !== 'string') return [];
    return [part['text']];
  });
  const text = texts.join('');
  return text.length === 0 ? undefined : text;
}

function toolOutput(result: unknown): ToolResultOutput {
  if (typeof result === 'string') return { type: 'text', value: result };
  if (result === undefined) return { type: 'json', value: {} };
  if (result === null) return { type: 'json', value: null };
  try {
    return { type: 'json', value: JSON.parse(JSON.stringify(result)) };
  } catch {
    return { type: 'text', value: String(result) };
  }
}

function isStep(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value['type'] === 'string' && STEP_TYPES.has(value['type'] as string);
}
