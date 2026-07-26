import type { ModelsDevModelMetadata } from '@aio-proxy/core';
import type { ModelCapabilities } from '@anthropic-ai/sdk/resources/models';

// The Anthropic Models API exposes a fixed capability superset. This is the
// subset /v1/models fills in from models.dev; it lives here (the assembly
// boundary) rather than in the shared catalog, which only passes raw signals.
export type ModelCapabilitiesSubset = Pick<
  ModelCapabilities,
  'effort' | 'image_input' | 'pdf_input' | 'structured_outputs' | 'thinking'
>;

function support(supported: boolean): { readonly supported: boolean } {
  return { supported };
}

// Returns null when metadata carries no capability signal at all, matching the
// pre-existing /v1/models contract (a bare metadata row reports capabilities: null).
export function toAnthropicCapabilities(metadata: ModelsDevModelMetadata): ModelCapabilitiesSubset | null {
  const hasSignal =
    metadata.reasoning !== undefined ||
    metadata.reasoning_options !== undefined ||
    metadata.modalities !== undefined ||
    metadata.structured_output !== undefined;
  if (!hasSignal) return null;

  const options = metadata.reasoning_options ?? [];
  const effort = options.find((option) => option.type === 'effort');
  const values = new Set(effort?.values ?? []);
  const inputs = metadata.modalities?.input ?? [];
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
    structured_outputs: support(metadata.structured_output === true),
    thinking: {
      supported: metadata.reasoning === true,
      types: {
        adaptive: support(effort !== undefined),
        enabled: support(options.some((option) => option.type === 'budget_tokens' || option.type === 'toggle')),
      },
    },
  };
}
