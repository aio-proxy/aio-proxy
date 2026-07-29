import type { ModelsDevModel } from '@aio-proxy/core';
import type { CodexUpstreamModel } from '@aio-proxy/types';

import instructions from './default-instructions.md' with { type: 'text' };

const DEFAULT_CONTEXT_WINDOW = 272_000;

const REASONING_DESCRIPTIONS = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
} as const;

const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ReasoningLevel = (typeof REASONING_LEVELS)[number];

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
  slug: string;
  displayName: string;
  metadata: ModelsDevModel | undefined;
  // A complete upstream ModelInfo cloned as the base so every required field is
  // present. Undefined only when the catalog cache is empty (first-run offline).
  template: CodexUpstreamModel | undefined;
};

function reasoningLevel(effort: ReasoningLevel) {
  return { effort, description: REASONING_DESCRIPTIONS[effort] };
}

// Codex is told exactly which effort levels the model accepts, read straight
// from the models.dev `effort` reasoning option. No metadata at all falls back
// to the full list (unknown, assume all); an explicit non-reasoning model
// yields an empty list, so we advertise no reasoning and no default level.
function reasoningLevelsFor(metadata: ModelsDevModel | undefined): readonly ReasoningLevel[] {
  if (metadata === undefined) return REASONING_LEVELS;
  const effort = metadata.reasoning_options?.find((option) => option.type === 'effort');
  if (effort === undefined) return [];
  const values = new Set(effort.values ?? []);
  return REASONING_LEVELS.filter((level) => values.has(level));
}

export function assembleCodexModel(input: AssembleInput): Record<string, unknown> {
  const text = instructions.replaceAll('{{model_name}}', input.slug);
  const contextWindow = input.metadata?.limit.input ?? input.metadata?.limit.context ?? DEFAULT_CONTEXT_WINDOW;

  // Codex's InputModality enum accepts only 'text' and 'image'; emitting 'pdf'
  // (a common models.dev signal, e.g. Claude) makes the client reject the whole
  // catalog. Case A passes the upstream codex row through verbatim, so this only
  // constrains synthesized (Case B) entries.
  const modalityInputs = input.metadata?.modalities.input;
  const inputModalities = modalityInputs
    ? ['text', ...(modalityInputs.includes('image') ? ['image'] : [])]
    : ['text', 'image'];

  const levels = reasoningLevelsFor(input.metadata);
  const supportedReasoningLevels = levels.map(reasoningLevel);
  // Empty levels (an explicit non-reasoning model) must omit the field entirely;
  // Codex rejects a default that is not listed and would drop the whole catalog.
  const defaultReasoningLevel = levels.includes('low') ? 'low' : levels[0];

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
    description: input.metadata?.description || '',
    priority: 999,
    supported_in_api: true,
    visibility: 'list',
    context_window: contextWindow,
    max_context_window: contextWindow,
    input_modalities: inputModalities,
    supported_reasoning_levels: supportedReasoningLevels,
    ...(defaultReasoningLevel === undefined ? {} : { default_reasoning_level: defaultReasoningLevel }),
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
