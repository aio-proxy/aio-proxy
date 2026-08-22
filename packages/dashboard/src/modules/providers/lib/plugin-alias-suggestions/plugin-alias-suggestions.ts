import type { ProviderAlias } from '@aio-proxy/types';
import { exposedAliases, normalizeAliasName } from '@aio-proxy/types';
import { pick } from 'es-toolkit/object';

import { type AliasRow, toAliasRows } from '../alias-editor';

/**
 * The plugin's suggestions, reduced to the ones this draft can accept — and the one place their keys
 * get normalized. The server passes plugin keys through verbatim, so a key like `' mini'` would
 * otherwise miss the row already named `mini` and land as a second row under the same name, which is
 * `alias-name-duplicate` and a greyed-out Save.
 *
 * An empty whitelist is not an empty set of legal targets: absent and empty both mean "no whitelist"
 * here exactly as they do in `aliasEditorIssues` and in the server's own validator, so there is
 * nothing to filter against.
 */
export const applicablePluginAliases = (
  suggestions: ProviderAlias | undefined,
  models: readonly string[],
): ProviderAlias | undefined => {
  if (suggestions === undefined) return undefined;
  // A key that normalizes away is unusable: appended as-is it reports `alias-name-required`.
  const named: ProviderAlias = Object.fromEntries(
    Object.entries(suggestions)
      .map(([name, config]) => [normalizeAliasName(name), config] as const)
      .filter(([name]) => name !== ''),
  );
  // Whole suggestions, never half: a surviving variant aimed outside the whitelist still reports
  // `target-missing`, which is the same greyed-out Save the filter exists to prevent. Shared with the
  // background refresh path in `insertMissingAliases`, which must satisfy the same refinement.
  const applicable = exposedAliases(named, models);
  // "No suggestions" keeps a single representation all the way to the button, which renders only
  // when this returns a value.
  return Object.keys(applicable).length === 0 ? undefined : applicable;
};

/**
 * Same-name replace: a suggestion overwrites the config of the row that already carries its name,
 * every other row is returned untouched, and names the draft does not have yet are appended.
 *
 * Precondition: `suggestions` keys are already normalized. `applicablePluginAliases` is the only
 * producer and guarantees it, so only `row.name` is normalized here.
 */
export const mergePluginAliasRows = (rows: readonly AliasRow[], suggestions: ProviderAlias): readonly AliasRow[] => {
  // Only `config` is replaced. `id` is the row's React key and the anchor its issues point at, so
  // reissuing it remounts the row and takes the caret with it; `name` stays verbatim because the
  // record key is the trimmed form either way, and rewriting it would edit text the user typed.
  const merged = rows.map((row) => {
    const name = normalizeAliasName(row.name);
    // `Object.hasOwn`, not a bare lookup: a row named `constructor` reaches an inherited
    // `Object.prototype` member, so a bracket read would replace that row's config with a function
    // and lose the target the user typed. Same membership test as `insertMissingAliases`.
    const config = Object.hasOwn(suggestions, name) ? suggestions[name] : undefined;
    return config === undefined ? row : { ...row, config };
  });
  const taken = new Set(rows.map((row) => normalizeAliasName(row.name)));
  const added = Object.keys(suggestions).filter((name) => !taken.has(name));
  // `toAliasRows` sees only the genuinely new keys. It mints an id per entry from the module-wide
  // sequence shared with `blankAliasRow`, which is what a new row needs and what an existing row
  // must not get.
  return added.length === 0 ? merged : [...merged, ...toAliasRows(pick(suggestions, added))];
};
