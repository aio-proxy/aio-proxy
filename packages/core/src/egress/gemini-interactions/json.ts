import type { TextStreamPart, ToolSet } from '../../ai-sdk-bridge';
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

export async function writeGeminiInteractionsResponse(
  stream: ReadableStream<GeminiInteractionsStreamPart>,
  context: ModelEgressContext,
): Promise<Interaction> {
  const text: string[] = [];
  const reasoning: string[] = [];
  const tools = new Map<string, ToolState>();
  let finishReason = 'unknown';
  let usage: TokenUsage | undefined;

  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta':
        text.push(part.text);
        break;
      case 'reasoning-delta':
        reasoning.push(part.text);
        break;
      case 'tool-input-start':
        tools.set(part.id, { id: part.id, name: part.toolName, input: '' });
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
  const steps = interactionSteps(text.join(''), reasoning.join(''), functionCalls);
  const status = interactionStatus(finishReason, functionCalls.length > 0);
  if (status === 'error') {
    throw new Error(`Gemini Interactions convert finished with ${finishReason}`);
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

function interactionSteps(
  outputText: string,
  thoughtText: string,
  functionCalls: readonly FunctionCallStep[],
): InteractionStep[] {
  const steps: InteractionStep[] = [];
  if (thoughtText.length > 0) {
    const thought = { type: 'thought' as const, summary: [{ type: 'text' as const, text: thoughtText }] };
    assertThoughtStep(thought);
    steps.push(thought);
  }
  if (outputText.length > 0) {
    steps.push({ type: 'model_output', content: [{ type: 'text', text: outputText }] });
  }
  steps.push(...functionCalls);
  return steps;
}

function functionCallStep(tool: ToolState): FunctionCallStep {
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
