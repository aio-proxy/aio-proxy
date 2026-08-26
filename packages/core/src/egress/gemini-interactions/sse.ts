import type { TextStreamPart, ToolSet } from '../../ai-sdk-bridge';
import type { ModelEgressContext, ModelSseStream } from '../../protocol/adapter';
import { createCancellableEgressStream } from '../cancellable-stream';
import {
  assertFunctionCallStep,
  assertThoughtStep,
  functionCallStep,
  type Interaction,
  type InteractionStep,
} from './json';
import { interactionStatus } from './status';
import { interactionUsage } from './usage';

const encoder = new TextEncoder();

type GeminiInteractionsStreamPart = TextStreamPart<ToolSet>;
type TokenUsage = Extract<GeminiInteractionsStreamPart, { type: 'finish' }>['totalUsage'];
type StepKind = 'thought' | 'model_output' | 'function_call';

type OpenStep = {
  readonly kind: StepKind;
  readonly index: number;
  readonly startedIndex: number;
  readonly id?: string;
};

type StartedStep = {
  readonly kind: StepKind;
  readonly id?: string;
  readonly text: string[];
};

type ToolState = {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  input: string;
  stopped: boolean;
};

type SseState = {
  eventSeq: number;
  nextIndex: number;
  open: OpenStep | undefined;
  failed: boolean;
  finishReason: string;
  usage: TokenUsage | undefined;
  readonly tools: Map<string, ToolState>;
  readonly started: StartedStep[];
  readonly enqueue: (value: Uint8Array) => void;
};

export function writeGeminiInteractionsSSE(
  stream: ReadableStream<GeminiInteractionsStreamPart>,
  context: ModelEgressContext,
): ModelSseStream {
  const created = new Date().toISOString();
  const id = `intr_${crypto.randomUUID()}`;
  return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
    const state: SseState = {
      eventSeq: 0,
      nextIndex: 0,
      open: undefined,
      failed: false,
      finishReason: 'unknown',
      usage: undefined,
      tools: new Map(),
      started: [],
      enqueue,
    };

    emitJson(state, 'interaction.created', {
      event_type: 'interaction.created',
      interaction: { id, object: 'interaction', model: context.modelId, status: 'in_progress' },
    });
    emitJson(state, 'interaction.status_update', {
      event_type: 'interaction.status_update',
      interaction_id: id,
      status: 'in_progress',
    });

    for await (const part of parts) {
      if (state.failed) break;
      handlePart(state, part);
    }
    if (state.failed) return;

    closeRemaining(state);
    try {
      const functionCalls = Array.from(state.tools.values()).map(functionCallStep);
      const status = interactionStatus(state.finishReason, functionCalls.length > 0);
      if (status === 'error') {
        emitError(state, `Gemini Interactions convert finished with ${state.finishReason}`);
        return;
      }

      const interaction: Interaction = {
        id,
        object: 'interaction',
        model: context.modelId,
        status,
        created,
        updated: created,
        steps: completedSteps(state),
        usage: interactionUsage(state.usage),
      };
      emitJson(state, 'interaction.completed', { event_type: 'interaction.completed', interaction });
      context.onResponseId?.(id);
      emitDone(state);
    } catch (error) {
      emitError(state, errorMessage(error));
    }
  });
}

function handlePart(state: SseState, part: GeminiInteractionsStreamPart): void {
  switch (part.type) {
    case 'reasoning-delta':
      emitThoughtDelta(state, part.text);
      break;
    case 'text-delta':
      emitTextDelta(state, part.text);
      break;
    case 'tool-input-start':
      startFunctionCall(state, part.id, part.toolName);
      break;
    case 'tool-input-delta':
      emitArgumentDelta(state, part.id, part.delta);
      break;
    case 'tool-input-end':
      closeFunctionCall(state, part.id);
      break;
    case 'error':
      emitError(state, errorMessage(part.error));
      break;
    case 'finish':
      state.finishReason = typeof part.finishReason === 'string' ? part.finishReason : 'unknown';
      state.usage = part.totalUsage;
      break;
    default:
      break;
  }
}

function emitThoughtDelta(state: SseState, text: string): void {
  if (text.length === 0 && state.open?.kind !== 'thought') return;
  ensureStep(state, 'thought');
  appendOpenText(state, text);
  if (text.length === 0 || state.open === undefined) return;
  emitJson(state, 'step.delta', {
    event_type: 'step.delta',
    index: state.open.index,
    delta: { type: 'thought_summary', content: { type: 'text', text } },
  });
}

function emitTextDelta(state: SseState, text: string): void {
  if (text.length === 0 && state.open?.kind !== 'model_output') return;
  ensureStep(state, 'model_output');
  appendOpenText(state, text);
  if (text.length === 0 || state.open === undefined) return;
  emitJson(state, 'step.delta', {
    event_type: 'step.delta',
    index: state.open.index,
    delta: { type: 'text', text },
  });
}

function startFunctionCall(state: SseState, id: string, name: string): void {
  if (id.length === 0 || name.length === 0) {
    emitError(state, id.length === 0 ? 'function_call step is missing id' : 'function_call step is missing name');
    return;
  }
  if (state.open !== undefined && state.open.kind !== 'function_call') closeOpen(state);
  const step = { type: 'function_call' as const, id, name, arguments: {} };
  assertFunctionCallStep(step);
  const index = state.nextIndex++;
  const startedIndex = state.started.length;
  state.open = { kind: 'function_call', index, startedIndex, id };
  state.tools.set(id, { id, name, index, input: '', stopped: false });
  state.started.push({ kind: 'function_call', id, text: [] });
  emitJson(state, 'step.start', { event_type: 'step.start', index, step });
}

function emitArgumentDelta(state: SseState, id: string, delta: string): void {
  const tool = state.tools.get(id);
  if (tool === undefined || tool.stopped) return;
  tool.input += delta;
  emitJson(state, 'step.delta', {
    event_type: 'step.delta',
    index: tool.index,
    delta: { type: 'arguments_delta', arguments: delta },
  });
}

function ensureStep(state: SseState, kind: Exclude<StepKind, 'function_call'>): void {
  if (state.open?.kind === kind) return;
  if (state.open !== undefined && state.open.kind !== 'function_call') closeOpen(state);
  const index = state.nextIndex++;
  const startedIndex = state.started.length;
  state.open = { kind, index, startedIndex };
  state.started.push({ kind, text: [] });
  emitJson(state, 'step.start', { event_type: 'step.start', index, step: { type: kind } });
}

function appendOpenText(state: SseState, text: string): void {
  if (state.open === undefined) return;
  state.started[state.open.startedIndex]?.text.push(text);
}

function closeFunctionCall(state: SseState, id: string): void {
  const tool = state.tools.get(id);
  if (tool === undefined || tool.stopped) return;
  emitJson(state, 'step.stop', { event_type: 'step.stop', index: tool.index });
  tool.stopped = true;
  if (state.open?.kind === 'function_call' && state.open.id === id) state.open = undefined;
}

function closeOpen(state: SseState): void {
  if (state.open === undefined) return;
  if (state.open.kind === 'function_call') {
    closeFunctionCall(state, state.open.id ?? '');
    return;
  }
  emitJson(state, 'step.stop', { event_type: 'step.stop', index: state.open.index });
  state.open = undefined;
}

function closeRemaining(state: SseState): void {
  closeOpen(state);
  for (const tool of state.tools.values()) {
    if (!tool.stopped) closeFunctionCall(state, tool.id);
  }
}

function completedSteps(state: SseState): InteractionStep[] {
  const tools = new Map(Array.from(state.tools.values(), (tool) => [tool.id, functionCallStep(tool)]));
  const steps: InteractionStep[] = [];
  for (const started of state.started) {
    const text = started.text.join('');
    if (started.kind === 'thought') {
      if (text.length === 0) continue;
      const thought = { type: 'thought' as const, summary: [{ type: 'text' as const, text }] };
      assertThoughtStep(thought);
      steps.push(thought);
      continue;
    }
    if (started.kind === 'model_output') {
      if (text.length > 0) steps.push({ type: 'model_output', content: [{ type: 'text', text }] });
      continue;
    }
    const call = started.id === undefined ? undefined : tools.get(started.id);
    if (call !== undefined) steps.push(call);
  }
  return steps;
}

function emitJson(state: SseState, eventType: string, payload: Record<string, unknown>): void {
  state.eventSeq += 1;
  const body = { event_id: `evt_${state.eventSeq}`, ...payload };
  state.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(body)}\n\n`));
}

function emitError(state: SseState, message: string): void {
  if (state.failed) return;
  state.failed = true;
  closeRemaining(state);
  emitJson(state, 'error', {
    event_type: 'error',
    error: { code: 500, message, status: 'INTERNAL' },
  });
  emitDone(state);
}

function emitDone(state: SseState): void {
  state.enqueue(encoder.encode('event: done\ndata: [DONE]\n\n'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
