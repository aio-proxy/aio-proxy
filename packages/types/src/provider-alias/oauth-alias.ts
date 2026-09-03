import { z } from 'zod';

import { AliasConfigSchema, flattenAliasVariants } from '../alias-variant';
import type { AliasConfig } from '../common';
import { normalizeAliasName } from '../common';
import type { ProviderAlias } from './provider-alias';

export type AuthoredOAuthAliasValue = AliasConfig | false;
export type AuthoredOAuthAlias = Readonly<Record<string, AuthoredOAuthAliasValue>>;

export const INHERIT_OFF_KEY = '*';

export const isAuthoredAliasConfig = (value: AuthoredOAuthAliasValue): value is AliasConfig => value !== false;

const AuthoredOAuthAliasValueSchema = z.unknown().transform((value, ctx): AuthoredOAuthAliasValue => {
  if (value === false) return false;
  const parsed = AliasConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: 'custom',
      message: issue.message,
      ...(issue.path.length === 0 ? {} : { path: issue.path }),
    });
  }
  return z.NEVER;
});

export const AuthoredOAuthAliasSchema = z
  .record(z.string().min(1), AuthoredOAuthAliasValueSchema)
  .superRefine((alias, ctx) => {
    for (const [key, value] of Object.entries(alias)) {
      if (normalizeAliasName(key) !== INHERIT_OFF_KEY) continue;
      if (value !== false) {
        ctx.addIssue({
          code: 'custom',
          message: 'Reserved alias key "*" only accepts false',
          path: [key],
        });
      }
    }
  });

export function oauthExposedModels(
  catalogIds: readonly string[],
  excludedModels: readonly string[] | undefined,
): string[] {
  if (excludedModels === undefined || excludedModels.length === 0) return [...catalogIds];
  const hidden = new Set(excludedModels);
  return catalogIds.filter((id) => !hidden.has(id));
}

export function resolveOAuthAlias(
  authored: AuthoredOAuthAlias | undefined,
  defaults: ProviderAlias | undefined,
  exposedCatalog?: readonly string[],
): ProviderAlias {
  const inheritOff = isInheritOff(authored);
  const resolved: Record<string, AliasConfig> = inheritOff ? {} : { ...defaults };
  if (authored !== undefined) {
    for (const [key, value] of Object.entries(authored)) {
      if (!Object.hasOwn(authored, key)) continue;
      const name = normalizeAliasName(key);
      if (name === '' || name === INHERIT_OFF_KEY) continue;
      if (value === false) {
        if (!inheritOff) delete resolved[name];
        continue;
      }
      resolved[name] = value;
    }
  }
  if (exposedCatalog === undefined) return resolved;
  const allowed = new Set(exposedCatalog);
  return Object.fromEntries(
    Object.entries(resolved).filter(([, config]) =>
      [config.model, ...flattenAliasVariants(config.variants).map((row) => row.model)].every((model) =>
        allowed.has(model),
      ),
    ),
  );
}

function isInheritOff(authored: AuthoredOAuthAlias | undefined): boolean {
  if (authored === undefined) return false;
  for (const [key, value] of Object.entries(authored)) {
    if (!Object.hasOwn(authored, key)) continue;
    if (normalizeAliasName(key) === INHERIT_OFF_KEY && value === false) return true;
  }
  return false;
}
