import { z } from 'zod';

import { ModelIdSchema } from '../common';

/** External models.dev slug enum referenced by the `extend` field in the emitted config JSON Schema. */
export const MODELS_DEV_MODEL_REF = 'https://models.dev/model-schema.json#/$defs/Model';

/** Discriminable meta marker read by the config JSON Schema override to emit the external models.dev $ref. */
const modelsDevRefMeta = { modelsDevRef: true } as const;

/**
 * Per-token prices are USD per 1,000,000 tokens — the same unit models.dev and the
 * internal OpenRouterModelPrice use, so config values flow into the pricing engine
 * without conversion. Per-request/per-image/per-call fees are USD per event.
 */
const NonNegativeNumberSchema = z.number().nonnegative();

const TokenClassPriceFields = {
  input: NonNegativeNumberSchema.optional().describe('Input token price, USD per 1M tokens.'),
  output: NonNegativeNumberSchema.optional().describe('Output token price, USD per 1M tokens.'),
  cacheRead: NonNegativeNumberSchema.optional().describe('Cache-read token price, USD per 1M tokens.'),
  cacheWrite: NonNegativeNumberSchema.optional().describe('Cache-write token price, USD per 1M tokens.'),
  reasoning: NonNegativeNumberSchema.optional().describe('Reasoning token price, USD per 1M tokens.'),
  inputAudio: NonNegativeNumberSchema.optional().describe('Audio input token price, USD per 1M tokens.'),
  outputAudio: NonNegativeNumberSchema.optional().describe('Audio output token price, USD per 1M tokens.'),
} as const;

/**
 * A graduated pricing tier that replaces the base token rates once the request's
 * context size passes `tier.size`. Mirrors the models.dev `cost.tiers` shape:
 * `{ tier: { type: 'context', size }, ...token rates }`.
 */
export const ModelCostTierSchema = z.object({
  tier: z.object({
    type: z.literal('context').describe('Tier trigger; only context-size tiers are supported.'),
    size: z.number().int().nonnegative().describe('Context size in tokens at which this tier begins to apply.'),
  }),
  ...TokenClassPriceFields,
});

export const ModelCostSchema = z
  .object({
    ...TokenClassPriceFields,
    image: NonNegativeNumberSchema.optional().describe('Image input price, USD per image.'),
    webSearch: NonNegativeNumberSchema.optional().describe('Web-search tool price, USD per call.'),
    request: NonNegativeNumberSchema.optional().describe('Flat per-request fee, USD per request.'),
    tiers: z.array(ModelCostTierSchema).optional().describe('Context-size pricing tiers, mirroring models.dev.'),
  })
  .loose();

export const ModelLimitSchema = z
  .object({
    context: z.number().int().positive().optional().describe('Total context window in tokens exposed to clients.'),
    input: z.number().int().positive().optional().describe('Maximum input tokens.'),
    output: z.number().int().positive().optional().describe('Maximum output tokens.'),
  })
  .loose();

/** Input/output data types a model supports, mirroring models.dev `modalities`. */
export const ModalitySchema = z.enum(['text', 'audio', 'image', 'video', 'pdf']);

export const ModelModalitiesSchema = z
  .object({
    input: z.array(ModalitySchema).optional().describe('Accepted input modalities.'),
    output: z.array(ModalitySchema).optional().describe('Produced output modalities.'),
  })
  .loose();

/** Reasoning effort levels a model accepts; `null` means reasoning can be disabled explicitly. Mirrors models.dev. */
export const ReasoningEffortSchema = z
  .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'])
  .nullable();

/**
 * How reasoning can be configured for a model, mirroring the models.dev `reasoning_options`
 * union. The `budget_tokens` variant is camelCased to `budgetTokens` for config consistency.
 */
export const ReasoningOptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('toggle') }).loose(),
  z.object({ type: z.literal('effort'), values: z.array(ReasoningEffortSchema) }).loose(),
  z
    .object({
      type: z.literal('budgetTokens'),
      min: z.number().int().optional().describe('Minimum reasoning budget in tokens; -1 means dynamic.'),
      max: z.number().int().optional().describe('Maximum reasoning budget in tokens.'),
    })
    .loose(),
]);

/**
 * Behavioral capability flags plus date metadata, mirroring the models.dev model
 * entry. All optional overrides of auto-discovered values; dates are display-only
 * strings (`YYYY-MM` or `YYYY-MM-DD`).
 */
export const ModelCapabilitiesSchema = z
  .object({
    reasoning: z.boolean().optional().describe('Model performs reasoning.'),
    temperature: z.boolean().optional().describe('Model accepts the temperature parameter.'),
    toolCall: z.boolean().optional().describe('Model supports tool/function calling.'),
    attachment: z.boolean().optional().describe('Model accepts file attachments.'),
    structuredOutput: z.boolean().optional().describe('Model supports structured (JSON schema) output.'),
    reasoningOptions: z
      .array(ReasoningOptionSchema)
      .optional()
      .describe('How reasoning can be configured (toggle / effort levels / token budget), mirroring models.dev.'),
    modalities: ModelModalitiesSchema.optional().describe('Supported input/output modalities.'),
    knowledge: z.string().optional().describe('Knowledge cutoff, YYYY-MM or YYYY-MM-DD.'),
    releaseDate: z.string().optional().describe('Release date, YYYY-MM or YYYY-MM-DD.'),
    lastUpdated: z.string().optional().describe('Last updated, YYYY-MM or YYYY-MM-DD.'),
  })
  .loose();

/**
 * Typed, field-allowlisted overrides for a model's client-facing metadata.
 * Keyed by upstream model id inside a provider's `metadata`.
 *
 * Unknown keys are preserved (`.loose()`) rather than rejected so a config authored
 * for a newer version does not hard-fail; callers warn on unknown keys instead.
 */
export const ModelMetadataSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe('Client-facing display name for this model, mirroring models.dev `Model.name`.'),
    description: z.string().optional().describe('Client-facing description for this model.'),
    extend: ModelIdSchema.meta(modelsDevRefMeta)
      .optional()
      .describe('models.dev slug to inherit metadata from when names differ.'),
    limit: ModelLimitSchema.optional().describe('Token limits, mirroring the models.dev `limit` object.'),
    capabilities: ModelCapabilitiesSchema.optional().describe('Capability flags and date metadata overrides.'),
    cost: ModelCostSchema.optional().describe('Per-model pricing overrides used for cost accounting.'),
  })
  .loose();

export type ModelCostTierInput = z.input<typeof ModelCostTierSchema>;
export type ModelCostTier = z.output<typeof ModelCostTierSchema>;
export type ModelCostInput = z.input<typeof ModelCostSchema>;
export type ModelCost = z.output<typeof ModelCostSchema>;
export type ModelLimitInput = z.input<typeof ModelLimitSchema>;
export type ModelLimit = z.output<typeof ModelLimitSchema>;
export type Modality = z.output<typeof ModalitySchema>;
export type ModelModalities = z.output<typeof ModelModalitiesSchema>;
export type ReasoningEffort = z.output<typeof ReasoningEffortSchema>;
export type ReasoningOption = z.output<typeof ReasoningOptionSchema>;
export type ModelCapabilitiesInput = z.input<typeof ModelCapabilitiesSchema>;
export type ModelCapabilities = z.output<typeof ModelCapabilitiesSchema>;
export type ModelMetadataInput = z.input<typeof ModelMetadataSchema>;
export type ModelMetadata = z.output<typeof ModelMetadataSchema>;

/** Allowlisted keys — anything outside this set is an unknown key we warn about. */
export const MODEL_METADATA_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'extend',
  'limit',
  'capabilities',
  'cost',
]);

const MODEL_COST_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoning',
  'inputAudio',
  'outputAudio',
  'image',
  'webSearch',
  'request',
  'tiers',
]);

/** Collect unknown (non-allowlisted) key paths in a parsed metadata record for warning. */
export function collectUnknownModelMetadataKeys(
  metadataByModelId: Readonly<Record<string, ModelMetadata>>,
): readonly string[] {
  const unknown: string[] = [];
  for (const [modelId, metadata] of Object.entries(metadataByModelId)) {
    for (const key of Object.keys(metadata)) {
      if (!MODEL_METADATA_KNOWN_KEYS.has(key)) {
        unknown.push(`${modelId}.${key}`);
      }
    }
    const cost = metadata.cost;
    if (cost !== undefined) {
      for (const key of Object.keys(cost)) {
        if (!MODEL_COST_KNOWN_KEYS.has(key)) {
          unknown.push(`${modelId}.cost.${key}`);
        }
      }
    }
  }
  return unknown;
}
