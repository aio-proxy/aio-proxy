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
  default_reasoning_level: zod.string().default('low'),
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

export function assembleCodexModel(input: AssembleInput): Record<string, unknown> {
  const text = instructions.replaceAll('{{model_name}}', input.slug);
  const contextWindow = input.metadata?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW;
  const capabilities = input.metadata?.capabilities;

  const inputModalities = ['text'];
  if (capabilities?.image_input?.supported) inputModalities.push('image');
  if (capabilities?.pdf_input?.supported) inputModalities.push('pdf');

  const effort = capabilities?.effort;
  const supportedReasoningLevels =
    !effort || !effort.supported
      ? REASONING_LEVELS.map(reasoningLevel)
      : REASONING_LEVELS.filter((level) => effort[level]?.supported).map(reasoningLevel);

  const scaffold = ScaffoldSchema.parse({});

  return {
    slug: input.slug,
    id: input.slug,
    display_name: input.displayName,
    context_window: contextWindow,
    max_context_window: contextWindow,
    input_modalities: inputModalities,
    supported_reasoning_levels: supportedReasoningLevels,
    default_reasoning_level: scaffold.default_reasoning_level,
    supports_search_tool: scaffold.supports_search_tool,
    base_instructions: text,
    model_messages: {
      instructions_template: text,
      instructions_variables: scaffold.instructions_variables,
      approvals: scaffold.approvals,
    },
  };
}
