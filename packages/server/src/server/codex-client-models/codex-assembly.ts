import type { ModelsDevModelMetadata } from '@aio-proxy/core';
import { zod } from '@aio-proxy/plugin-sdk';

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

// Constant scaffold fields are materialized from zod defaults per the design decision.
const ScaffoldSchema = zod.object({
  // CodexModelBaseSchema requires priority/supported_in_api/visibility; a
  // synthesized entry that omits them is rejected by the Codex client. Synthesized
  // entries already sort after the template group, so priority only needs a stable
  // large default rather than gpt-5.6-sol's 1.
  priority: zod.number().default(999),
  supported_in_api: zod.boolean().default(true),
  visibility: zod.string().default('list'),
  description: zod.string().default(''),
  supports_search_tool: zod.boolean().default(false),
  instructions_variables: zod.record(zod.string(), zod.unknown()).default({}),
  approvals: zod.null().default(null),
});

type AssembleInput = {
  slug: string;
  displayName: string;
  metadata: ModelsDevModelMetadata | undefined;
};

function reasoningLevel(effort: ReasoningLevel) {
  return { effort, description: REASONING_DESCRIPTIONS[effort] };
}

// Codex is told exactly which effort levels the model accepts, read straight
// from the models.dev `effort` reasoning option. No metadata at all falls back
// to the full list (unknown, assume all); an explicit non-reasoning model
// yields an empty list, so we advertise no reasoning and no default level.
function reasoningLevelsFor(metadata: ModelsDevModelMetadata | undefined): readonly ReasoningLevel[] {
  if (metadata === undefined) return REASONING_LEVELS;
  const effort = metadata.reasoning_options?.find((option) => option.type === 'effort');
  if (effort === undefined) return [];
  const values = new Set(effort.values ?? []);
  return REASONING_LEVELS.filter((level) => values.has(level));
}

export function assembleCodexModel(input: AssembleInput): Record<string, unknown> {
  const text = instructions.replaceAll('{{model_name}}', input.slug);
  const contextWindow = input.metadata?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW;

  // Codex's InputModality enum accepts only 'text' and 'image'; emitting 'pdf'
  // (a common models.dev signal, e.g. Claude) makes the client reject the whole
  // catalog. Case A passes the upstream codex row through verbatim, so this only
  // constrains synthesized (Case B) entries.
  const modalityInputs = input.metadata?.modalities?.input;
  const inputModalities = modalityInputs
    ? ['text', ...(modalityInputs.includes('image') ? ['image'] : [])]
    : ['text', 'image'];

  const levels = reasoningLevelsFor(input.metadata);
  const supportedReasoningLevels = levels.map(reasoningLevel);
  const defaultReasoningLevel = levels.includes('low') ? 'low' : (levels[0] ?? '');

  const scaffold = ScaffoldSchema.parse({});

  return {
    slug: input.slug,
    id: input.slug,
    display_name: input.displayName,
    description: scaffold.description,
    priority: scaffold.priority,
    supported_in_api: scaffold.supported_in_api,
    visibility: scaffold.visibility,
    context_window: contextWindow,
    max_context_window: contextWindow,
    input_modalities: inputModalities,
    supported_reasoning_levels: supportedReasoningLevels,
    default_reasoning_level: defaultReasoningLevel,
    supports_search_tool: scaffold.supports_search_tool,
    base_instructions: text,
    model_messages: {
      instructions_template: text,
      instructions_variables: scaffold.instructions_variables,
      approvals: scaffold.approvals,
    },
  };
}
