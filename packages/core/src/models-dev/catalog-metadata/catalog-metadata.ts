import type {
  ModelCapabilities,
  ModelCost,
  ModelCostTier,
  ModelLimit,
  ModelMetadata,
  ReasoningOption,
} from '@aio-proxy/types';
import type { Cost, CostTier, Model, ReasoningOption as ModelsDevReasoningOption } from '@opencode-ai/models';

// Legacy models.dev pricing beyond 200K context is expressed as a single
// `context_over_200k` block. We normalize it into the tier shape at this fixed
// boundary so downstream code only reasons about `tiers`.
const CONTEXT_OVER_200K_SIZE = 200_000;

/**
 * Convert a models.dev catalog `Model` into the config `ModelMetadata` shape,
 * camelCasing field names and normalizing the legacy `context_over_200k` price
 * block into a single context tier. Optional fields are omitted rather than set
 * to `undefined` so the result satisfies `exactOptionalPropertyTypes`.
 */
export function catalogModelToMetadata(model: Model): ModelMetadata {
  return {
    name: model.name,
    description: model.description,
    limit: toLimit(model),
    capabilities: toCapabilities(model),
    ...(model.cost === undefined ? {} : { cost: toCost(model.cost) }),
  };
}

function toLimit(model: Model): ModelLimit {
  const { context, input, output } = model.limit;
  return {
    context,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

function toCapabilities(model: Model): ModelCapabilities {
  return {
    reasoning: model.reasoning,
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    toolCall: model.tool_call,
    attachment: model.attachment,
    ...(model.structured_output === undefined ? {} : { structuredOutput: model.structured_output }),
    ...(model.reasoning_options === undefined
      ? {}
      : { reasoningOptions: model.reasoning_options.map(toReasoningOption) }),
    modalities: { input: model.modalities.input, output: model.modalities.output },
    ...(model.knowledge === undefined ? {} : { knowledge: model.knowledge }),
    releaseDate: model.release_date,
    lastUpdated: model.last_updated,
  };
}

function toReasoningOption(option: ModelsDevReasoningOption): ReasoningOption {
  if (option.type === 'budget_tokens') {
    return {
      type: 'budgetTokens',
      ...(option.min === undefined ? {} : { min: option.min }),
      ...(option.max === undefined ? {} : { max: option.max }),
    };
  }
  if (option.type === 'effort') return { type: 'effort', values: option.values };
  return { type: 'toggle' };
}

function toCost(cost: Model['cost'] & object): ModelCost {
  const tiers = toTiers(cost);
  return {
    input: cost.input,
    output: cost.output,
    ...spreadSharedRates(cost),
    ...(tiers === undefined ? {} : { tiers }),
  };
}

function toTiers(cost: Model['cost'] & object): ModelCostTier[] | undefined {
  // Explicit tiers win; the legacy `context_over_200k` block is only synthesized
  // into a tier when no explicit tiers are present.
  if (cost.tiers !== undefined) return cost.tiers.map(toTier);
  if (cost.context_over_200k !== undefined) {
    return [
      {
        tier: { type: 'context', size: CONTEXT_OVER_200K_SIZE },
        input: cost.context_over_200k.input,
        output: cost.context_over_200k.output,
        ...spreadSharedRates(cost.context_over_200k),
      },
    ];
  }
  return undefined;
}

function toTier(tier: CostTier): ModelCostTier {
  return {
    tier: tier.tier,
    input: tier.input,
    output: tier.output,
    ...spreadSharedRates(tier),
  };
}

// Rates shared by every models.dev `Cost` block: the camelCase-only optional
// fields (cache/audio/reasoning). `input`/`output` are handled by callers since
// they are required on the base cost but absent from the metadata tier defaults.
function spreadSharedRates(
  cost: Cost,
): Partial<Pick<ModelCost, 'cacheRead' | 'cacheWrite' | 'reasoning' | 'inputAudio' | 'outputAudio'>> {
  return {
    ...(cost.cache_read === undefined ? {} : { cacheRead: cost.cache_read }),
    ...(cost.cache_write === undefined ? {} : { cacheWrite: cost.cache_write }),
    ...(cost.reasoning === undefined ? {} : { reasoning: cost.reasoning }),
    ...(cost.input_audio === undefined ? {} : { inputAudio: cost.input_audio }),
    ...(cost.output_audio === undefined ? {} : { outputAudio: cost.output_audio }),
  };
}
