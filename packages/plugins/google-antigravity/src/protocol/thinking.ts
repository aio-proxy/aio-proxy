import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

import { type ThinkingMode, classifyProvider } from '../catalog/classify';
import type { AntigravityFamily, Effort } from '../catalog/collapse';

export type CcaThinkingConfig = {
  readonly thinkingBudget: number;
  readonly includeThoughts: boolean;
};

export type AntigravityThinkingOption =
  | { readonly mode: 'disabled' }
  | { readonly mode: 'fixed'; readonly budgetTokens: number }
  | { readonly mode: 'adaptive'; readonly effort: string };

export class AntigravityThinkingError extends Error {
  override readonly name = 'AntigravityThinkingError';
}

const GEMINI_EFFORTS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high']);
const CLAUDE_ADAPTIVE: Readonly<Record<string, number>> = {
  low: 4096,
  medium: 8192,
  high: 16_384,
  max: 32_768,
};
const CLAUDE_FIXED_FLOOR = 1024;
const EMPTY_CATALOG: ModelCatalog = {
  language: [],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
};

export function bindAntigravityThinking(catalog: ModelCatalog = EMPTY_CATALOG) {
  return {
    applyAntigravityThinking: (modelId: string, thinking: AntigravityThinkingOption) =>
      applyAntigravityThinking(modelId, thinking, catalog),
    geminiThinkingConfig: (modelId: string, thinkingConfig: Readonly<Record<string, unknown>>) =>
      geminiThinkingConfig(modelId, thinkingConfig, catalog),
  };
}

export function applyAntigravityThinking(
  modelId: string,
  thinking: AntigravityThinkingOption,
  catalog: ModelCatalog = EMPTY_CATALOG,
): Readonly<Record<string, unknown>> {
  const wire = resolveWire(catalog, modelId);
  switch (thinking.mode) {
    case 'disabled':
      return ccaConfig(0);
    case 'fixed':
      return applyFixed(wire, thinking.budgetTokens);
    case 'adaptive':
      return applyAdaptive(wire, thinking.effort);
    default:
      throw new AntigravityThinkingError('Unsupported thinking mode');
  }
}

export function geminiThinkingConfig(
  modelId: string,
  thinkingConfig: Readonly<Record<string, unknown>>,
  catalog: ModelCatalog = EMPTY_CATALOG,
): Readonly<Record<string, unknown>> {
  const wire = resolveWire(catalog, modelId);
  if (wire.mode === 'none') return thinkingConfig;
  const thinkingLevel = Reflect.get(thinkingConfig, 'thinkingLevel');
  if (typeof thinkingLevel !== 'string') {
    throw new AntigravityThinkingError('Gemini thinkingLevel is required');
  }
  const { thinkingLevel: _removed, ...siblings } = thinkingConfig;
  if (wire.mode === 'claude') {
    return { ...siblings, ...ccaConfig(claudeAdaptiveBudget(thinkingLevel)) };
  }
  return { ...siblings, ...mapGeminiEffort(wire, thinkingLevel) };
}

type ResolvedWire = {
  readonly modelId: string;
  readonly mode: ThinkingMode;
  readonly family: AntigravityFamily | undefined;
  readonly thinkingBudget: number | undefined;
  readonly minThinkingBudget: number | undefined;
  readonly maxOutputTokens: number | undefined;
};

function applyAdaptive(wire: ResolvedWire, effort: string): Readonly<Record<string, unknown>> {
  if (wire.mode === 'none') return { thinkingLevel: effort };
  if (wire.mode === 'claude') return ccaConfig(claudeAdaptiveBudget(effort));
  return mapGeminiEffort(wire, effort);
}

function applyFixed(wire: ResolvedWire, budgetTokens: number): CcaThinkingConfig {
  if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) {
    throw new AntigravityThinkingError('Invalid fixed thinking budget');
  }
  if (wire.mode === 'claude') {
    const floor = Math.max(CLAUDE_FIXED_FLOOR, wire.minThinkingBudget ?? CLAUDE_FIXED_FLOOR);
    if (budgetTokens < floor) {
      throw new AntigravityThinkingError('Invalid fixed thinking budget');
    }
    if (wire.maxOutputTokens !== undefined && budgetTokens >= wire.maxOutputTokens) {
      throw new AntigravityThinkingError('Invalid fixed thinking budget');
    }
    return ccaConfig(budgetTokens);
  }
  if (
    wire.mode === 'gemini' &&
    wire.minThinkingBudget !== undefined &&
    budgetTokens > 0 &&
    budgetTokens < wire.minThinkingBudget
  ) {
    throw new AntigravityThinkingError('Invalid fixed thinking budget');
  }
  return ccaConfig(budgetTokens);
}

function mapGeminiEffort(wire: ResolvedWire, rawEffort: string): Readonly<Record<string, unknown>> {
  const effort = normalizeGeminiEffort(rawEffort);
  if (effort === 'off' || effort === 'none') return ccaConfig(0);
  if (effort === 'minimal') return geminiMinimal(wire);
  if (wire.family?.kind === 'split' && !splitVariantMatches(wire.family, wire.modelId, effort)) {
    throw new AntigravityThinkingError(`Unsupported thinking effort ${effort} for ${wire.modelId}`);
  }
  return geminiBudgetOrLevel(wire, effort);
}

function normalizeGeminiEffort(rawEffort: string): string {
  const effort = rawEffort.trim().toLowerCase();
  if (effort === 'xhigh') return 'high';
  if (!GEMINI_EFFORTS.has(effort)) {
    throw new AntigravityThinkingError(`Unsupported thinking effort ${rawEffort}`);
  }
  return effort;
}

function geminiMinimal(wire: ResolvedWire): CcaThinkingConfig {
  if (!wire.modelId.endsWith('-extra-low')) {
    throw new AntigravityThinkingError(`Unsupported thinking effort minimal for ${wire.modelId}`);
  }
  if (wire.thinkingBudget === undefined || wire.thinkingBudget <= 0) {
    throw new AntigravityThinkingError(`Unsupported thinking effort minimal for ${wire.modelId}`);
  }
  return ccaConfig(wire.thinkingBudget);
}

function splitVariantMatches(family: AntigravityFamily, modelId: string, effort: string): boolean {
  return family.variants.some((variant) => variant.effort === effort && variant.model === modelId);
}

function geminiBudgetOrLevel(wire: ResolvedWire, effort: string): Readonly<Record<string, unknown>> {
  if (wire.thinkingBudget !== undefined && wire.thinkingBudget > 0) return ccaConfig(wire.thinkingBudget);
  return { thinkingLevel: effort };
}

function claudeAdaptiveBudget(effort: string): number {
  const normalized = effort.trim().toLowerCase() === 'xhigh' ? 'high' : effort.trim().toLowerCase();
  const budget = CLAUDE_ADAPTIVE[normalized];
  if (budget === undefined) {
    throw new AntigravityThinkingError(`Unsupported thinking effort ${effort}`);
  }
  return budget;
}

function resolveWire(catalog: ModelCatalog, modelId: string): ResolvedWire {
  const family = familyForWire(catalog, modelId);
  const descriptor = catalog.language.find((model) => model.id === modelId);
  const fields = antigravityFields(descriptor);
  return {
    modelId,
    mode: family?.thinking.mode ?? classifyProvider(descriptor ?? {}),
    family,
    thinkingBudget: fields.thinkingBudget,
    minThinkingBudget: fields.minThinkingBudget,
    maxOutputTokens: fields.maxOutputTokens,
  };
}

function familyForWire(catalog: ModelCatalog, modelId: string): AntigravityFamily | undefined {
  return readAntigravityFamilies(catalog.metadata).find(
    (family) => family.base === modelId || family.variants.some((variant) => variant.model === modelId),
  );
}

function readAntigravityFamilies(metadata: unknown): readonly AntigravityFamily[] {
  if (!isRecord(metadata) || !Array.isArray(metadata['antigravityFamilies'])) return [];
  const families: AntigravityFamily[] = [];
  for (const value of metadata['antigravityFamilies']) {
    const family = asFamily(value);
    if (family !== undefined) families.push(family);
  }
  return families;
}

function asFamily(value: unknown): AntigravityFamily | undefined {
  if (!isRecord(value)) return undefined;
  const logicalId = asString(value['logicalId']);
  const base = asString(value['base']);
  const kind = value['kind'];
  const thinking = value['thinking'];
  const thinkingMode = isRecord(thinking) ? thinking['mode'] : undefined;
  if (logicalId === undefined || base === undefined) return undefined;
  if (kind !== 'split' && kind !== 'tiered' && kind !== 'same-wire') return undefined;
  if (thinkingMode !== 'gemini' && thinkingMode !== 'claude' && thinkingMode !== 'none') return undefined;
  if (!Array.isArray(value['variants'])) return undefined;
  const variants: { effort: Effort; model: string }[] = [];
  for (const row of value['variants']) {
    if (!isRecord(row)) continue;
    const effort = row['effort'];
    const model = asString(row['model']);
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') continue;
    if (model === undefined) continue;
    variants.push({ effort, model });
  }
  return { logicalId, kind, thinking: { mode: thinkingMode }, base, variants };
}

function antigravityFields(descriptor: ModelDescriptor | undefined) {
  const source = providerSource(descriptor?.metadata);
  return {
    thinkingBudget: asFiniteNumber(source?.['thinkingBudget']),
    minThinkingBudget: asFiniteNumber(source?.['minThinkingBudget']),
    maxOutputTokens: asFiniteNumber(source?.['maxOutputTokens']),
  };
}

function providerSource(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined;
  return isRecord(metadata['antigravity']) ? metadata['antigravity'] : metadata;
}

function ccaConfig(thinkingBudget: number): CcaThinkingConfig {
  return { thinkingBudget, includeThoughts: thinkingBudget > 0 };
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
