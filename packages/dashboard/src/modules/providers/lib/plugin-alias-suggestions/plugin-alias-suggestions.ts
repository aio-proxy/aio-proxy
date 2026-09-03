import type { ProviderAlias } from '@aio-proxy/types';
import { exposedAliases, normalizeAliasName } from '@aio-proxy/types';

/**
 * The plugin's suggestions, reduced to the ones this draft can accept — and the one place their keys
 * get normalized. The server passes plugin keys through verbatim, so a key like `' mini'` would
 * otherwise miss the row already named `mini` and land as a second row under the same name, which is
 * `alias-name-duplicate` and a greyed-out Save.
 *
 * `models` is the draft exposed set (`catalog − excludedModels` on OAuth, the whitelist on api /
 * ai-sdk). Absent and empty still mean "do not filter targets" — the same contract as
 * `exposedAliases` — so an unfetched OAuth catalog does not wipe every suggestion.
 */
export const applicablePluginAliases = (
  suggestions: ProviderAlias | undefined,
  models: readonly string[],
): ProviderAlias | undefined => {
  if (suggestions === undefined) return undefined;
  const named: ProviderAlias = Object.fromEntries(
    Object.entries(suggestions)
      .map(([name, config]) => [normalizeAliasName(name), config] as const)
      .filter(([name]) => name !== ''),
  );
  const applicable = exposedAliases(named, models);
  return Object.keys(applicable).length === 0 ? undefined : applicable;
};
