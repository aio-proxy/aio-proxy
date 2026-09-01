import {
  catalogModelToMetadata,
  getModels,
  getModelsCachedOnly,
  hasCachedModelsCatalog,
  type ModelsDevModel,
} from '@aio-proxy/core';
import { aliasTargetModels, type Config, type ModelMetadata, ProviderKind, type Provider } from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';

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

  const cachedOnly = deps?.getModels === undefined;
  const catalogCached = !cachedOnly || (await hasCachedModelsCatalog());
  const catalog = await resolveCatalog(ids, deps?.getModels ?? getModelsCachedOnly);
  if (!catalogCached && deps?.onCatalogWarmed !== undefined) {
    void getModels(ids).then(deps.onCatalogWarmed, () => {});
  }

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
// Ids whose router policy already declares an output modality are skipped so an
// explicit authored value is never second-guessed by the catalog beneath it.
function routableUpstreamIds(config: Config): string[] {
  const authored = authoredOutputModalitySlugs(config);
  const ids = config.providers.flatMap((provider) =>
    provider.kind === ProviderKind.OAuth ? [] : providerRoutableIds(provider),
  );
  return uniq(ids).filter((id) => !authored.has(id));
}

function providerRoutableIds(provider: Provider): string[] {
  const alias = 'alias' in provider ? provider.alias : undefined;
  return [...(provider.models ?? []), ...(alias === undefined ? [] : Object.values(alias).flatMap(aliasTargetModels))];
}

function authoredOutputModalitySlugs(config: Config): Set<string> {
  const slugs = new Set<string>();
  for (const [slug, policy] of Object.entries(config.router.models)) {
    if (policy.metadata?.capabilities?.modalities?.output !== undefined) slugs.add(slug);
  }
  return slugs;
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
