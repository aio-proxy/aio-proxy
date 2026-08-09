import {
  catalogModelToMetadata,
  type getModels,
  getModelsCachedOnly,
  type ModelsDevModel,
  type PluginLogSink,
} from '@aio-proxy/core';
import { type Config, type ModelMetadata, ModelMetadataSchema, type Provider } from '@aio-proxy/types';
import { mergeWith } from 'es-toolkit/object';

/** Injection seam so tests can supply a catalog without touching the network/global cache. */
export type ResolveExtendDeps = {
  readonly getModels?: typeof getModels;
};

/**
 * Resolve every provider's `metadata[modelId].extend` into a fully materialized
 * metadata entry. `extend: 'openai/gpt-5.5'` means: take that slug's models.dev
 * catalog entry as the BASE layer, then deep-merge the entry's other explicit
 * fields on top (user wins). The resolved entry drops the `extend` key.
 *
 * Providers without metadata, and metadata entries without `extend`, pass through
 * with their original object identity. Unresolved targets keep the user's fields
 * (minus `extend`) and emit a warning; resolution never throws or blocks snapshot
 * build.
 */
export async function applyMetadataExtend(
  config: Config,
  logger?: PluginLogSink,
  deps?: ResolveExtendDeps,
): Promise<Config> {
  const slugs = collectExtendSlugs(config.providers);
  if (slugs.size === 0) return config;

  const catalog = await resolveCatalog([...slugs], deps?.getModels ?? getModelsCachedOnly);

  let changed = false;
  const providers = config.providers.map((provider) => {
    const rewritten = rewriteProvider(provider, catalog, logger);
    if (rewritten !== provider) changed = true;
    return rewritten;
  });
  return changed ? { ...config, providers } : config;
}

function collectExtendSlugs(providers: readonly Provider[]): Set<string> {
  const slugs = new Set<string>();
  for (const provider of providers) {
    const metadata = providerMetadata(provider);
    if (metadata === undefined) continue;
    for (const meta of Object.values(metadata)) {
      if (meta.extend !== undefined) slugs.add(meta.extend);
    }
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

function rewriteProvider(
  provider: Provider,
  catalog: Record<string, ModelsDevModel | undefined>,
  logger: PluginLogSink | undefined,
): Provider {
  const metadata = providerMetadata(provider);
  if (metadata === undefined) return provider;

  let changed = false;
  const next: Record<string, ModelMetadata> = {};
  for (const [modelId, meta] of Object.entries(metadata)) {
    if (meta.extend === undefined) {
      next[modelId] = meta;
      continue;
    }
    changed = true;
    next[modelId] = resolveEntry(provider.id, modelId, meta, catalog, logger);
  }
  if (!changed) return provider;
  return { ...provider, metadata: next } as Provider;
}

function resolveEntry(
  providerId: string,
  modelId: string,
  meta: ModelMetadata,
  catalog: Record<string, ModelsDevModel | undefined>,
  logger: PluginLogSink | undefined,
): ModelMetadata {
  const slug = meta.extend as string;
  const { extend: _extend, ...userFields } = meta;
  const target = catalog[slug];
  if (target === undefined) {
    warnUnresolved(providerId, modelId, slug, logger);
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
    context: { providerId },
    error: {
      name: 'MetadataExtendInvalid',
      message: `metadata.extend target '${slug}' for model '${modelId}' produced invalid merged metadata; ignoring inheritance`,
    },
  });
  return userFields;
}

function warnUnresolved(providerId: string, modelId: string, slug: string, logger: PluginLogSink | undefined): void {
  logger?.({
    event: 'metadata.extend.unresolved',
    code: 'PROVIDER_CONFIG_INVALID',
    context: { providerId },
    error: {
      name: 'MetadataExtendUnresolved',
      message: `metadata.extend target '${slug}' for model '${modelId}' not found in models.dev catalog; ignoring`,
    },
  });
}

function providerMetadata(provider: Provider): Record<string, ModelMetadata> | undefined {
  return 'metadata' in provider ? provider.metadata : undefined;
}
