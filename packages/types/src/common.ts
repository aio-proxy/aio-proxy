import type { AliasConfig, AliasTarget } from './alias-variant';

export { IdSchema, ModelIdSchema, type ModelId, type ModelIdInput } from './model-id';

export { AliasConfigSchema, AliasTargetSchema } from './alias-variant';
export type { AliasConfig, AliasConfigInput, AliasTarget, AliasTargetInput } from './alias-variant';

export const normalizeAliasName = (value: string): string => value.trim();

export const normalizeVariantKey = (value: string): string => value.trim().toLowerCase();

// Legacy resolver kept until Task 5 rewires the hot path; it mishandles array variants.
export function resolveAliasTarget(config: AliasConfig, variantKey: string | undefined): AliasTarget {
  if (variantKey !== undefined) {
    const normalizedKey = normalizeVariantKey(variantKey);
    for (const [key, target] of Object.entries(config.variants ?? {})) {
      if (normalizeVariantKey(key) === normalizedKey) {
        return target;
      }
    }
  }

  return { model: config.model, preserve: config.preserve };
}
