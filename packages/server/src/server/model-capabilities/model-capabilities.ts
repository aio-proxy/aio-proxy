import type { ModelsDevModel } from '@aio-proxy/core';
import type { ModelCapabilities } from '@anthropic-ai/sdk/resources/models';

// The Anthropic Models API exposes a fixed capability superset. This is the
// subset /v1/models fills in from the raw models.dev record; it lives here (the
// assembly boundary), not in the shared catalog which only passes Model through.
export type ModelCapabilitiesSubset = Pick<
  ModelCapabilities,
  'effort' | 'image_input' | 'pdf_input' | 'structured_outputs' | 'thinking'
>;

function support(supported: boolean): { readonly supported: boolean } {
  return { supported };
}

// Derives the Anthropic capabilities shape from a models.dev Model. Callers pass
// null capabilities when there is no metadata at all (see /v1/models).
export function toAnthropicCapabilities(model: ModelsDevModel): ModelCapabilitiesSubset {
  const options = model.reasoning_options ?? [];
  const effort = options.find((option) => option.type === 'effort');
  const values = new Set(effort?.values ?? []);
  const inputs = model.modalities.input;
  return {
    effort: {
      high: support(values.has('high')),
      low: support(values.has('low')),
      max: support(values.has('max')),
      medium: support(values.has('medium')),
      supported: effort !== undefined,
      xhigh: support(values.has('xhigh')),
    },
    image_input: support(inputs.includes('image')),
    pdf_input: support(inputs.includes('pdf')),
    structured_outputs: support(model.structured_output === true),
    thinking: {
      supported: model.reasoning === true,
      types: {
        adaptive: support(effort !== undefined),
        enabled: support(options.some((option) => option.type === 'budget_tokens' || option.type === 'toggle')),
      },
    },
  };
}
