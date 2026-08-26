import type { TextStreamPart, ToolSet } from '../../ai-sdk-bridge';
import { GeminiInteractionsEgressError } from '../../error';
import type { ModelEgressContext } from '../../protocol/adapter';
import { interactionStatus, type InteractionStatus } from './status';
import { interactionUsage, type InteractionUsage } from './usage';

type GeminiInteractionsStreamPart = TextStreamPart<ToolSet>;
type TokenUsage = Extract<GeminiInteractionsStreamPart, { type: 'finish' }>['totalUsage'];

type ToolState = {
  readonly id: string;
  readonly name: string;
  input: string;
};

export type TextContent = {
  readonly type: 'text';
  readonly text: string;
};

export type ThoughtStep = {
  readonly type: 'thought';
  readonly summary: readonly TextContent[];
};

export type ModelOutputStep = {
  readonly type: 'model_output';
  readonly content: readonly TextContent[];
};

export type FunctionCallStep = {
  readonly type: 'function_call';
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

export type InteractionStep = ThoughtStep | ModelOutputStep | FunctionCallStep;

export type Interaction = {
  readonly id: string;
  readonly object: 'interaction';
  readonly model: string;
  readonly status: Exclude<InteractionStatus, 'error'>;
  readonly created: string;
  readonly updated: string;
  readonly steps: readonly InteractionStep[];
  readonly usage: InteractionUsage;
};

type StartedJsonStep = {
  readonly kind: 'thought' | 'model_output' | 'function_call';
  readonly id?: string;
  readonly text: string[];
};

export async function writeGeminiInteractionsResponse(
  stream: ReadableStream<GeminiInteractionsStreamPart>,
  context: ModelEgressContext,
): Promise<Interaction> {
  const started: StartedJsonStep[] = [];
  const tools = new Map<string, ToolState>();
  let finishReason = 'unknown';
  let usage: TokenUsage | undefined;

  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta':
        appendJsonText(started, 'model_output', part.text);
        break;
      case 'reasoning-delta':
        appendJsonText(started, 'thought', part.text);
        break;
      case 'tool-input-start':
        tools.set(part.id, { id: part.id, name: part.toolName, input: '' });
        started.push({ kind: 'function_call', id: part.id, text: [] });
        break;
      case 'tool-input-delta': {
        const tool = tools.get(part.id);
        if (tool !== undefined) tool.input += part.delta;
        break;
      }
      case 'error':
        throw part.error;
      case 'finish':
        finishReason = typeof part.finishReason === 'string' ? part.finishReason : 'unknown';
        usage = part.totalUsage;
        break;
      default:
        break;
    }
  }

  const functionCalls = Array.from(tools.values()).map(functionCallStep);
  const steps = orderedJsonSteps(started, tools);
  const status = interactionStatus(finishReason, functionCalls.length > 0);
  if (status === 'error') {
    throw new GeminiInteractionsEgressError(finishReason);
  }

  const created = new Date().toISOString();
  const interaction: Interaction = {
    id: `intr_${crypto.randomUUID()}`,
    object: 'interaction',
    model: context.modelId,
    status,
    created,
    updated: created,
    steps,
    usage: interactionUsage(usage),
  };
  context.onResponseId?.(interaction.id);
  return interaction;
}

export function assertFunctionCallStep(step: unknown): asserts step is FunctionCallStep {
  if (!isRecord(step) || step['type'] !== 'function_call') {
    throw new Error('Invalid function_call step');
  }
  const id = step['id'];
  const name = step['name'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('function_call step is missing id');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('function_call step is missing name');
  }
  if (!isRecord(step['arguments'])) {
    throw new Error('function_call step is missing arguments');
  }
}

export function assertThoughtStep(step: unknown): asserts step is ThoughtStep {
  if (!isRecord(step) || step['type'] !== 'thought') {
    throw new Error('Invalid thought step');
  }
  if ('content' in step) {
    throw new Error('thought step must not include content');
  }
  if (!Array.isArray(step['summary'])) {
    throw new Error('thought step is missing summary');
  }
}

function appendJsonText(started: StartedJsonStep[], kind: 'thought' | 'model_output', text: string): void {
  const last = started.at(-1);
  if (last?.kind === kind) {
    last.text.push(text);
    return;
  }
  started.push({ kind, text: [text] });
}

function orderedJsonSteps(
  started: readonly StartedJsonStep[],
  tools: ReadonlyMap<string, ToolState>,
): InteractionStep[] {
  const calls = new Map(Array.from(tools.values(), (tool) => [tool.id, functionCallStep(tool)]));
  const steps: InteractionStep[] = [];
  for (const item of started) {
    const text = item.text.join('');
    if (item.kind === 'thought') {
      if (text.length === 0) continue;
      const thought = { type: 'thought' as const, summary: [{ type: 'text' as const, text }] };
      assertThoughtStep(thought);
      steps.push(thought);
      continue;
    }
    if (item.kind === 'model_output') {
      if (text.length > 0) steps.push({ type: 'model_output', content: [{ type: 'text', text }] });
      continue;
    }
    const call = item.id === undefined ? undefined : calls.get(item.id);
    if (call !== undefined) steps.push(call);
  }
  return steps;
}

export function functionCallStep(tool: {
  readonly id: string;
  readonly name: string;
  readonly input: string;
}): FunctionCallStep {
  const step = {
    type: 'function_call' as const,
    id: tool.id,
    name: tool.name,
    arguments: parseJsonObject(tool.input),
  };
  assertFunctionCallStep(step);
  return step;
}

function parseJsonObject(value: string): Record<string, unknown> {
  if (value.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? { ...parsed } : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
