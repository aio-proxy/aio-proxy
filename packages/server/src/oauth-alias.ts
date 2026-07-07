import type { AliasConfig } from "@aio-proxy/types";

/**
 * Derives the client-facing alias map for an OAuth provider from its vendor
 * model id list plus optional config alias overrides.
 *
 * Rules (applied in order):
 *  1. Each vendor model id gets an auto self-alias `M -> { model: M, preserve: false }`.
 *  2. Config aliases are merged on top; a config key wins over an auto entry.
 *  3. Collision guard: the auto self-alias for `M` is omitted when any config
 *     entry targets `M`. A `preserve: true` config makes `modelRoutes()` emit an
 *     extra `{ alias: config.model }` route, so keeping the auto self-alias too
 *     would produce two `provider/M` routes and throw RouterModelCollisionError.
 *  4. Config entries whose target is not a known vendor model are kept but each
 *     emits a `console.warn`, since those provider routes may 404 upstream.
 *
 * Output order is deterministic: surviving auto self-aliases in `modelIds` order,
 * then config keys in config insertion order.
 */
export function deriveOAuthAlias(
  modelIds: readonly string[],
  configAlias: Readonly<Record<string, AliasConfig>> | undefined,
): Readonly<Record<string, AliasConfig>> {
  const config = configAlias ?? {};
  const knownModels = new Set(modelIds);
  const targetedModels = new Set<string>();
  for (const entry of Object.values(config)) {
    if (knownModels.has(entry.model)) {
      targetedModels.add(entry.model);
    }
  }

  const alias: Record<string, AliasConfig> = {};

  for (const model of modelIds) {
    if (config[model] !== undefined || targetedModels.has(model)) {
      continue;
    }
    alias[model] = { model, preserve: false };
  }

  for (const [key, entry] of Object.entries(config)) {
    if (!knownModels.has(entry.model)) {
      console.warn(`[aio-proxy] oauth alias targets unknown vendor model "${entry.model}" (provider routes may 404)`);
    }
    alias[key] = entry;
  }

  return alias;
}
