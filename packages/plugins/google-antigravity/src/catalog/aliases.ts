import type { DefaultAliasSuggestions, ModelCatalog } from "@aio-proxy/plugin-sdk";

import { ANTIGRAVITY_FAMILIES } from "./families";

export function defaultAntigravityAliases(catalog: ModelCatalog): DefaultAliasSuggestions {
  const available = new Set(catalog.language.map(({ id }) => id));
  const aliases: Record<string, DefaultAliasSuggestions[string]> = {};

  for (const family of ANTIGRAVITY_FAMILIES) {
    if (!available.has(family.base)) continue;
    const variants: Record<string, { readonly model: string; readonly preserve: false }> = {};
    for (const [effort, model] of Object.entries(family.variants)) {
      if (available.has(model)) variants[effort] = { model, preserve: false };
    }
    aliases[family.logicalId] = {
      model: family.base,
      preserve: false,
      ...(Object.keys(variants).length === 0 ? {} : { variants }),
    };
  }

  return aliases;
}
