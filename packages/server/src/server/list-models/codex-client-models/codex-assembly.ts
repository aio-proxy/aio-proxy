import type { CodexUpstreamModel, ModelCapabilities, ModelMetadata } from '@aio-proxy/types';

import instructions from './default-instructions.md' with { type: 'text' };

const REASONING_DESCRIPTIONS = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
} as const;

const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ReasoningLevel = (typeof REASONING_LEVELS)[number];

// Renders the bundled base prompt for a slug. Case B uses it as the synthesized
// instructions; Case A uses it only as the last-resort fallback when an upstream
// row carries neither base_instructions nor model_messages.instructions_template.
export function renderDefaultInstructions(slug: string): string {
  return instructions.replaceAll('{{model_name}}', slug);
}

// Codex's ModelInfo struct requires these fields (no serde default, non-Option);
// a synthesized entry that omits any one makes the client reject the whole
// `Vec<ModelInfo>` and show an empty picker. When a cached upstream template is
// available these come from the clone, so this only backstops the offline
// (empty-cache) path. Values mirror the upstream gpt-5.5 template.
const REQUIRED_DEFAULTS = {
  shell_type: 'shell_command',
  truncation_policy: { mode: 'tokens', limit: 10_000 },
  support_verbosity: true,
  default_verbosity: 'low',
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [] as string[],
  apply_patch_tool_type: 'freeform',
} as const;

type AssembleInput = {
  readonly slug: string;
  readonly displayName: string;
  readonly metadata: Pick<ModelMetadata, 'description' | 'capabilities'> | undefined;
  readonly contextWindow: number;
  readonly maxContextWindow: number;
  // A complete upstream ModelInfo cloned as the base so every required field is
  // present. Undefined only when the catalog cache is empty (first-run offline).
  readonly template: CodexUpstreamModel | undefined;
};

function reasoningLevel(effort: ReasoningLevel) {
  return { effort, description: REASONING_DESCRIPTIONS[effort] };
}

function reasoningLevelsFor(
  options: ModelCapabilities['reasoningOptions'],
  reasoning: ModelCapabilities['reasoning'],
  fillDefaults: boolean,
): readonly ReasoningLevel[] | undefined {
  if (reasoning === false) return [];
  if (options === undefined) {
    return fillDefaults ? REASONING_LEVELS : undefined;
  }
  const effort = options.find((option) => option.type === 'effort');
  if (effort === undefined) return [];
  const values = new Set(effort.values ?? []);
  return REASONING_LEVELS.filter((level) => values.has(level));
}

export function projectCodexMetadata(
  metadata: Pick<ModelMetadata, 'description' | 'capabilities'> | undefined,
  fillDefaults: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (metadata?.description !== undefined || fillDefaults) {
    patch['description'] = metadata?.description ?? '';
  }

  const inputs = metadata?.capabilities?.modalities?.input;
  if (inputs !== undefined || fillDefaults) {
    patch['input_modalities'] = ['text', ...((inputs ?? ['image']).includes('image') ? ['image'] : [])];
  }

  const levels = reasoningLevelsFor(
    metadata?.capabilities?.reasoningOptions,
    metadata?.capabilities?.reasoning,
    fillDefaults,
  );
  if (levels !== undefined) {
    patch['supported_reasoning_levels'] = levels.map(reasoningLevel);
    const defaultLevel = levels.includes('low') ? 'low' : levels[0];
    if (defaultLevel !== undefined) patch['default_reasoning_level'] = defaultLevel;
  }
  return patch;
}

export function assembleCodexModel(input: AssembleInput): Record<string, unknown> {
  const text = renderDefaultInstructions(input.slug);

  // Clone a complete template so every required field is inherited; fall back to
  // REQUIRED_DEFAULTS offline. Template values win where present, defaults fill gaps.
  const base: Record<string, unknown> = {
    ...REQUIRED_DEFAULTS,
    ...(input.template ? structuredClone(input.template) : {}),
  };
  // Model-specific promo/routing fields from the template must not leak onto a
  // synthesized third-party model. default_reasoning_level is re-set below only
  // when there are levels, so drop the inherited one to avoid an unlisted default.
  delete base['availability_nux'];
  delete base['upgrade'];
  delete base['default_reasoning_level'];

  return {
    ...base,
    slug: input.slug,
    id: input.slug,
    display_name: input.displayName,
    priority: 999,
    supported_in_api: true,
    visibility: 'list',
    context_window: input.contextWindow,
    max_context_window: input.maxContextWindow,
    ...projectCodexMetadata(input.metadata, true),
    supports_search_tool: false,
    prefer_websockets: false,
    service_tiers: [],
    base_instructions: text,
    model_messages: {
      instructions_template: text,
      instructions_variables: {},
      approvals: null,
    },
  };
}
