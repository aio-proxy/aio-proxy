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

function stepMessages(steps: readonly unknown[]): readonly ModelMessage[] {
  const toolNames = new Map<string, string>();
  const messages: ModelMessage[] = [];
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const message = stepMessage(step, toolNames);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

function stepMessage(step: Record<string, unknown>, toolNames: Map<string, string>): ModelMessage | undefined {
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
    case 'function_call': {
      const id = typeof step['id'] === 'string' ? step['id'] : '';
      const name = typeof step['name'] === 'string' ? step['name'] : '';
      if (id !== '') toolNames.set(id, name);
      return {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: step['arguments'] ?? {} }],
      } satisfies AssistantMessage;
    }
    case 'function_result': {
      const callId = typeof step['call_id'] === 'string' ? step['call_id'] : '';
      const name = typeof step['name'] === 'string' ? step['name'] : (toolNames.get(callId) ?? '');
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            toolName: name,
            output: toolOutput(step['result']),
          },
        ],
      } satisfies ToolMessage;
    }
    default:
      return undefined;
  }
}

function userTextMessage(text: string): ModelMessage {
  return { role: 'user', content: text };
}

function textFromContents(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (value === undefined) return undefined;
  const parts = Array.isArray(value) ? value : [value];
  const texts = parts.flatMap((part) => {
    if (!isRecord(part) || typeof part['text'] !== 'string') return [];
    return [part['text']];
  });
  if (texts.length === 0) return undefined;
  return texts.join('');
}

function toolOutput(result: unknown): ToolResultOutput {
  if (typeof result === 'string') return { type: 'text', value: result };
  if (result === undefined || result === null) return { type: 'json', value: {} };
  try {
    return { type: 'json', value: JSON.parse(JSON.stringify(result)) };
  } catch {
    return { type: 'text', value: String(result) };
  }
}

function isStep(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value['type'] === 'string' && STEP_TYPES.has(value['type'] as string);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
