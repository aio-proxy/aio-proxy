export { IdSchema, ModelIdSchema, type ModelId, type ModelIdInput } from './model-id';

export { AliasConfigSchema, AliasTargetSchema, resolveAliasTarget } from './alias-variant';
export type { AliasConfig, AliasConfigInput, AliasTarget, AliasTargetInput } from './alias-variant';

export const normalizeAliasName = (value: string): string => value.trim();

export const normalizeVariantKey = (value: string): string => value.trim().toLowerCase();
