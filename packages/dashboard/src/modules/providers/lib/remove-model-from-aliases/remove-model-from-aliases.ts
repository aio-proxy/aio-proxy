import type { AliasConfig } from '@aio-proxy/types';
import { flattenAliasVariants } from '@aio-proxy/types';

import { type ProviderAlias, toAliasVariants } from '../alias-editor';

export const removeModelFromAliases = (alias: ProviderAlias, modelId: string): ProviderAlias => {
  const next: Record<string, AliasConfig> = {};
  for (const [name, config] of Object.entries(alias)) {
    if (config.model === modelId) continue;
    const variants = toAliasVariants(flattenAliasVariants(config.variants).filter((row) => row.model !== modelId));
    next[name] =
      variants === undefined
        ? { model: config.model, preserve: config.preserve }
        : { model: config.model, preserve: config.preserve, variants };
  }
  return next;
};
