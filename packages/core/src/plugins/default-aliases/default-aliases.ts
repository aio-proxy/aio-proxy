import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import {
  AliasConfigSchema,
  aliasTargetModels,
  INHERIT_OFF_KEY,
  normalizeAliasName,
  type ProviderAlias,
} from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

/**
 * Catalog-valid plugin default aliases only. One bad entry drops itself, not the map.
 * A throwing hook or a non-object return is empty defaults, not a failed login.
 */
export function pluginDefaultAliases(adapter: OAuthAdapter, catalog: ModelCatalog): ProviderAlias | undefined {
  try {
    const raw = adapter.catalog.defaultAliases?.(catalog);
    if (!isPlainObject(raw)) return undefined;
    const models = new Set(catalog.language.map(({ id }) => id));
    const applicable: Record<string, ProviderAlias[string]> = {};
    for (const [key, suggestion] of Object.entries(raw)) {
      if (!Object.hasOwn(raw, key)) continue;
      const name = normalizeAliasName(key);
      if (name === '' || name === INHERIT_OFF_KEY || Object.hasOwn(applicable, name)) continue;
      const parsed = AliasConfigSchema.safeParse(suggestion);
      if (!parsed.success) continue;
      if (aliasTargetModels(parsed.data).some((model) => !models.has(model))) continue;
      applicable[name] = parsed.data;
    }
    return Object.keys(applicable).length === 0 ? undefined : applicable;
  } catch {
    return undefined;
  }
}
