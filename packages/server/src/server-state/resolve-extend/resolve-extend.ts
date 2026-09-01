import {
  catalogModelToMetadata,
  getModels,
  getModelsCachedOnly,
  type ModelsDevModel,
  type PluginLogSink,
} from '@aio-proxy/core';
import { type Config, type ModelMetadata, ModelMetadataSchema, type RouterModelPolicy } from '@aio-proxy/types';
import { mergeWith } from 'es-toolkit/object';

import { catalogCachedOrWarming } from '../warm-catalog/index';

/** Injection seam so tests can supply a catalog without touching the network/global cache. */
export type ResolveExtendDeps = {
  readonly getModels?: typeof getModels;
  /** Called after a cold catalog is warmed without delaying the current snapshot. */
  readonly onCatalogWarmed?: () => void;
};

/**
 * Resolve every router model's `metadata.extend` into a fully materialized
 * metadata entry. `extend: 'openai/gpt-5.5'` means: take that slug's models.dev
 * catalog entry as the BASE layer, then deep-merge the entry's other explicit
 * fields on top (user wins). The resolved entry drops the `extend` key.
 *
 * Router models without metadata, and metadata entries without `extend`, pass through
 * with their original object identity. Unresolved targets keep the user's fields
 * (minus `extend`) and emit a warning; resolution never throws or blocks snapshot
 * build.
 */
export async function applyMetadataExtend(
  config: Config,
  logger?: PluginLogSink,
  deps?: ResolveExtendDeps,
): Promise<Config> {
  const slugs = collectExtendSlugs(config.router.models);
  if (slugs.size === 0) return config;

  const cachedOnly = deps?.getModels === undefined;
  const catalogCached = !cachedOnly || (await catalogCachedOrWarming(deps?.onCatalogWarmed));
  const catalog = await resolveCatalog([...slugs], deps?.getModels ?? getModelsCachedOnly);

  const preserveUnresolved =
    !catalogCached || (cachedOnly && Object.values(catalog).some((model) => model === undefined));
  let changed = false;
  const models: Record<string, RouterModelPolicy> = {};
  for (const [slug, policy] of Object.entries(config.router.models)) {
    if (policy.metadata?.extend === undefined) {
      models[slug] = policy;
      continue;
    }
    changed = true;
    models[slug] = {
      ...policy,
      metadata: resolveEntry(slug, policy.metadata, catalog, logger, preserveUnresolved),
    };
  }
  return changed ? { ...config, router: { ...config.router, models } } : config;
}

function collectExtendSlugs(models: Readonly<Record<string, RouterModelPolicy>>): Set<string> {
  const slugs = new Set<string>();
  for (const policy of Object.values(models)) {
    if (policy.metadata?.extend !== undefined) slugs.add(policy.metadata.extend);
  }
  return slugs;
}

async function resolveCatalog(
  slugs: string[],
  resolve: typeof getModels,
): Promise<Record<string, ModelsDevModel | undefined>> {
  try {
    return await resolve(slugs);
  } catch {
    // Treat a catalog fetch failure as all-targets-unresolved rather than
    // failing the whole snapshot build.
    return {};
  }
}

function resolveEntry(
  slug: string,
  meta: ModelMetadata,
  catalog: Record<string, ModelsDevModel | undefined>,
  logger: PluginLogSink | undefined,
  preserveUnresolved: boolean,
): ModelMetadata {
  const targetSlug = meta.extend as string;
  const { extend: _extend, ...userFields } = meta;
  const target = catalog[targetSlug];
  if (target === undefined) {
    if (preserveUnresolved) return meta;
    warnUnresolved(slug, targetSlug, logger);
    return userFields;
  }
  // `base` is a fresh object from the mapper; mergeWith mutates its first arg,
  // so mutating `base` here is safe. Arrays (reasoningOptions/modalities.*/tiers)
  // replace wholesale; objects deep-merge; scalars source-win; undefined user
  // fields do not clobber inherited values.
  const base = catalogModelToMetadata(target);
  const merged = mergeWith(base, userFields, (_target, source) => (Array.isArray(source) ? source : undefined));
  const parsed = ModelMetadataSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  logger?.({
    event: 'metadata.extend.invalid',
    code: 'PROVIDER_CONFIG_INVALID',
    context: { model: slug },
    error: {
      name: 'MetadataExtendInvalid',
      message: `metadata.extend target '${targetSlug}' for model '${slug}' produced invalid merged metadata; ignoring inheritance`,
    },
  });
  return userFields;
}

function warnUnresolved(model: string, slug: string, logger: PluginLogSink | undefined): void {
  logger?.({
    event: 'metadata.extend.unresolved',
    code: 'PROVIDER_CONFIG_INVALID',
    context: { model },
    error: {
      name: 'MetadataExtendUnresolved',
      message: `metadata.extend target '${slug}' for model '${model}' not found in models.dev catalog; ignoring`,
    },
  });
}
