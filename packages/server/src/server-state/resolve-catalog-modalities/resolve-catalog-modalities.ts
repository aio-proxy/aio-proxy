import { catalogModelToMetadata, getModels, getModelsCachedOnly, type ModelsDevModel } from '@aio-proxy/core';
import { aliasTargetModels, type Config, type ModelMetadata, ProviderKind, type Provider } from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';

import { catalogCachedOrWarming } from '../warm-catalog/index';

/** Injection seam so tests can supply a catalog without touching the network/global cache. */
export type ResolveCatalogModalitiesDeps = {
  readonly getModels?: typeof getModels;
  /** Called after a cold catalog is warmed without delaying the current snapshot. */
  readonly onCatalogWarmed?: () => void;
};

/**
 * models.dev metadata for every routable upstream model id, keyed by that id.
 *
 * This is the LOWEST metadata layer (`catalog < upstream < config`), and it exists so the
 * capability index can answer "does this id produce images?" for providers that only list the
 * id in `models`. `/v1/models` already applies the same models.dev fallback via
 * `resolveEnabledModels`, so without this the listing reports an image model that routing then
 * rejects with 501.
 *
 * Cached-only by design: a cold catalog yields `{}` rather than blocking snapshot build, and
 * `onCatalogWarmed` requeues a rebuild once the fetch lands.
 */
export async function resolveCatalogModalities(
  config: Config,
  deps?: ResolveCatalogModalitiesDeps,
): Promise<Record<string, ModelMetadata>> {
  const ids = routableUpstreamIds(config);
  if (ids.length === 0) return {};

  // Queues a background warm when the catalog is cold. The current snapshot still
  // resolves from whatever the caches already hold rather than waiting on it.
  if (deps?.getModels === undefined) await catalogCachedOrWarming(deps?.onCatalogWarmed);
  const catalog = await resolveCatalog(ids, deps?.getModels ?? getModelsCachedOnly);

  const resolved: Record<string, ModelMetadata> = {};
  for (const id of ids) {
    const model = catalog[id];
    if (model === undefined) continue;
    try {
      resolved[id] = catalogModelToMetadata(model);
    } catch {
      // A malformed catalog entry drops to "no fallback for this id" rather than
      // failing every other id in the snapshot.
    }
  }
  return resolved;
}

// Non-OAuth providers only: an OAuth/plugin catalog already declares `catalog.image`
// explicitly, and that stays the authoritative source for those providers.
//
// Authored `router.models` metadata is deliberately NOT consulted here. Its keys are
// public slugs while these are upstream model ids, and the capability index this feeds
// is id-keyed and shared by every slug and alias routing to that id — so filtering by
// slug name suppresses unrelated routes (a text-only `gpt-image-2` policy would strip
// image from an `art -> gpt-image-2` alias) while never firing for the route it meant
// to protect. Suppression belongs to the id-keyed layer above: see
// `catalogOnlyImageOutput`, where upstream metadata outranks this catalog.
function routableUpstreamIds(config: Config): string[] {
  return uniq(
    config.providers.flatMap((provider) => (provider.kind === ProviderKind.OAuth ? [] : providerRoutableIds(provider))),
  );
}

function providerRoutableIds(provider: Exclude<Provider, { kind: typeof ProviderKind.OAuth }>): string[] {
  const alias = provider.alias;
  return [...(provider.models ?? []), ...(alias === undefined ? [] : Object.values(alias).flatMap(aliasTargetModels))];
}

async function resolveCatalog(
  ids: string[],
  resolve: typeof getModels,
): Promise<Record<string, ModelsDevModel | undefined>> {
  try {
    return await resolve(ids);
  } catch {
    // Treat a catalog fetch failure as all-ids-unresolved rather than failing
    // the whole snapshot build.
    return {};
  }
}
