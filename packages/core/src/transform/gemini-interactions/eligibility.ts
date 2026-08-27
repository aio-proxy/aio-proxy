import { GeminiInteractionsUnsupportedFeatureError } from '../../error';
import type { GeminiInteractionsBody, GeminiInteractionsRequest } from '../../ingress/gemini-interactions/index';

const KNOWN_TOP_LEVEL = new Set([
  'model',
  'agent',
  'input',
  'system_instruction',
  'stream',
  'tools',
  'response_format',
  'generation_config',
  'agent_config',
  'store',
  'background',
  'previous_interaction_id',
  'environment',
  'labels',
  'safety_settings',
  'service_tier',
  'webhook_config',
]);

const PRESENT_UNSUPPORTED = [
  'previous_interaction_id',
  'environment',
  'labels',
  'safety_settings',
  'service_tier',
  'webhook_config',
] as const;

type FunctionCallState = {
  readonly name: string;
  resolved: boolean;
};

const STEP_TYPES = new Set(['user_input', 'model_output', 'thought', 'function_call', 'function_result']);
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document']);
const MEDIA_DATA_KEYS = ['inline_data', 'file_data', 'inlineData', 'fileData'];
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);
const TOOL_CHOICE_MODES = new Set(['auto', 'none']);
const FUNCTION_TOOL_KEYS = new Set(['name', 'description', 'parameters', 'type']);
const GENERATION_CONFIG_KEYS = new Set([
  'max_output_tokens',
  'seed',
  'stop_sequences',
  'thinking_level',
  'thinking_summaries',
  'tool_choice',
]);

export function assertGeminiInteractionsConvertible(request: GeminiInteractionsRequest): void {
  const { body } = request;
  if (request.idField === 'agent') unsupported('agent', 'agent');
  if (body.agent_config !== undefined) unsupported('agent_config', 'agent_config');
  if (body.store !== false) unsupported('store', 'store');
  if (body.background === true) unsupported('background', 'background');
  for (const field of PRESENT_UNSUPPORTED) {
    if (body[field] !== undefined) unsupported(field, field);
  }
  for (const key of Object.keys(body)) {
    if (!KNOWN_TOP_LEVEL.has(key)) unsupported(key, key);
  }
  assertGenerationConfig(body.generation_config);
  assertResponseFormat(body.response_format);
  assertTools(body.tools);
  assertInput(body.input);
}

function assertGenerationConfig(value: GeminiInteractionsBody['generation_config']): void {
  if (value === undefined) return;
  if (!isRecord(value)) unsupported('generation_config', 'generation_config');
  for (const [key, member] of Object.entries(value)) {
    const path = `generation_config.${key}`;
    if (!GENERATION_CONFIG_KEYS.has(key)) unsupported(path, path);
    if (key === 'max_output_tokens') {
      if (typeof member !== 'number' || !Number.isInteger(member) || member <= 0) unsupported(path, path);
      continue;
    }
    if (key === 'seed') {
      if (typeof member !== 'number' || !Number.isInteger(member)) unsupported(path, path);
      continue;
    }
    if (key === 'stop_sequences') {
      if (!Array.isArray(member) || member.some((item) => typeof item !== 'string')) unsupported(path, path);
      continue;
    }
    if (key === 'thinking_level') {
      if (typeof member !== 'string' || !THINKING_LEVELS.has(member)) unsupported(path, path);
      continue;
    }
    if (key === 'thinking_summaries') {
      if (member !== 'none') unsupported(path, path);
      continue;
    }
    if (!isToolChoice(member)) unsupported(path, path);
  }
}

function isToolChoice(value: unknown): boolean {
  if (value === 'auto' || value === 'none') return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'allowed_tools') return false;
  const allowed = value['allowed_tools'];
  if (!isRecord(allowed)) return false;
  for (const key of Object.keys(allowed)) {
    if (key !== 'mode' && key !== 'tools') return false;
  }
  const mode = allowed['mode'];
  const tools = allowed['tools'];
  if (typeof mode !== 'string' || !TOOL_CHOICE_MODES.has(mode)) return false;
  return tools === undefined || (Array.isArray(tools) && tools.length === 0);
}

function assertResponseFormat(value: GeminiInteractionsBody['response_format']): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length !== 1 || !isTextPlainFormat(value[0])) unsupported('response_format', 'response_format');
    return;
  }
  if (!isTextPlainFormat(value)) unsupported('response_format', 'response_format');
}

function isTextPlainFormat(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'type' && key !== 'mime_type')) return false;
  if (value['type'] !== 'text') return false;
  const mime = value['mime_type'];
  return mime === undefined || mime === 'text/plain';
}

function assertTools(value: GeminiInteractionsBody['tools']): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every(isFunctionTool)) unsupported('tools', 'tools');
  const names = new Set<string>();
  for (const tool of value) {
    const name = isRecord(tool) && typeof tool['name'] === 'string' ? tool['name'] : '';
    if (names.has(name)) unsupported('tools', 'tools');
    names.add(name);
  }
}

function isFunctionTool(value: unknown): boolean {
  if (!isRecord(value) || typeof value['name'] !== 'string' || isEmptyIdentifier(value['name'])) return false;
  if (Object.keys(value).some((key) => !FUNCTION_TOOL_KEYS.has(key))) return false;
  const type = value['type'];
  if (type !== undefined && type !== 'function') return false;
  const description = value['description'];
  if (description !== undefined && typeof description !== 'string') return false;
  const parameters = value['parameters'];
  return parameters === undefined || isRecord(parameters);
}

function assertInput(input: GeminiInteractionsBody['input']): void {
  if (typeof input === 'string') return;
  if (Array.isArray(input)) {
    if (input.length === 0) return;
    if (input.every(isStep)) {
      const calls = new Map<string, FunctionCallState>();
      const seenIds = new Set<string>();
      for (const step of input) assertStep(step, calls, seenIds);
      rejectUnresolvedCalls(calls);
      return;
    }
    if (input.every((item) => isRecord(item) && !isStep(item))) {
      for (const part of input) assertContent(part);
      return;
    }
    unsupported('input', 'input');
  }
  if (isRecord(input) && !isStep(input)) {
    assertContent(input);
    return;
  }
  unsupported('input', 'input');
}

function assertStep(step: Record<string, unknown>, calls: Map<string, FunctionCallState>, seenIds: Set<string>): void {
  const type = step['type'];
  if (typeof type !== 'string' || !STEP_TYPES.has(type)) unsupported('input', 'input');
  if (type === 'thought' && 'content' in step) unsupported('input', 'input');
  if (type === 'thought') {
    assertTextContents(step['summary']);
    rejectPartialCallExchange(calls);
    return;
  }
  if (type === 'user_input') {
    rejectUnresolvedCalls(calls);
    calls.clear();
    assertTextContents(step['content']);
    return;
  }
  if (type === 'model_output') {
    assertTextContents(step['content']);
    rejectPartialCallExchange(calls);
    return;
  }
  if (type === 'function_call') {
    assertFunctionCall(step);
    if (![...calls.values()].some((call) => !call.resolved)) calls.clear();
    const id = step['id'] as string;
    if (seenIds.has(id)) unsupported('input', 'input');
    seenIds.add(id);
    calls.set(id, { name: step['name'] as string, resolved: false });
    return;
  }
  assertFunctionResult(step, calls);
}

function assertFunctionCall(step: Record<string, unknown>): void {
  if (typeof step['id'] !== 'string' || isEmptyIdentifier(step['id'])) unsupported('input', 'input');
  if (typeof step['name'] !== 'string' || isEmptyIdentifier(step['name'])) unsupported('input', 'input');
  if (step['arguments'] !== undefined && !isRecord(step['arguments'])) unsupported('input', 'input');
}

function assertFunctionResult(step: Record<string, unknown>, calls: Map<string, FunctionCallState>): void {
  if (typeof step['call_id'] !== 'string' || isEmptyIdentifier(step['call_id'])) unsupported('input', 'input');
  if (!('result' in step)) unsupported('input', 'input');
  const call = calls.get(step['call_id']);
  if (call === undefined || call.resolved) unsupported('input', 'input');
  const authoredName = step['name'];
  if (authoredName !== undefined && authoredName !== call.name) unsupported('input', 'input');
  call.resolved = true;
}

function rejectUnresolvedCalls(calls: Map<string, FunctionCallState>): void {
  for (const call of calls.values()) {
    if (!call.resolved) unsupported('input', 'input');
  }
}

function rejectPartialCallExchange(calls: Map<string, FunctionCallState>): void {
  let pending = false;
  let resolved = false;
  for (const call of calls.values()) {
    if (call.resolved) resolved = true;
    else pending = true;
  }
  if (pending && resolved) unsupported('input', 'input');
}

function assertTextContents(value: unknown): void {
  if (typeof value === 'string') {
    if (value.length === 0) unsupported('input', 'input');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) unsupported('input', 'input');
    let nonempty = false;
    for (const part of value) {
      assertContent(part);
      if (isRecord(part) && typeof part['text'] === 'string' && part['text'].length > 0) nonempty = true;
    }
    if (!nonempty) unsupported('input', 'input');
    return;
  }
  if (isRecord(value)) {
    assertContent(value);
    if (typeof value['text'] === 'string' && value['text'].length === 0) unsupported('input', 'input');
    return;
  }
  unsupported('input', 'input');
}

function assertContent(value: unknown): void {
  if (!isRecord(value)) unsupported('input', 'input');
  if (hasMedia(value)) unsupported('input', 'input');
  const type = value['type'];
  if (type !== undefined && type !== 'text') unsupported('input', 'input');
  if (typeof value['text'] !== 'string') unsupported('input', 'input');
}

function hasMedia(value: Record<string, unknown>): boolean {
  const type = value['type'];
  if (typeof type === 'string' && MEDIA_TYPES.has(type)) return true;
  return MEDIA_DATA_KEYS.some((key) => key in value);
}

function isStep(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value['type'] === 'string' && STEP_TYPES.has(value['type'] as string);
}

function unsupported(feature: string, path: string): never {
  throw new GeminiInteractionsUnsupportedFeatureError(feature, path);
}

function isEmptyIdentifier(value: string): boolean {
  return value.trim() === '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
