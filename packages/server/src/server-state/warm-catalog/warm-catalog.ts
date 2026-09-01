import { getProviders, hasCachedModelsCatalog } from '@aio-proxy/core';

/** Injection seam so tests can drive the cold/warm paths without network or global cache. */
export type WarmCatalogDeps = {
  readonly hasCachedModelsCatalog?: typeof hasCachedModelsCatalog;
  readonly getProviders?: typeof getProviders;
};

/**
 * Whether models.dev's provider catalog is already on disk, queueing a background
 * warm when it is not so the caller can resolve cached-only without blocking.
 *
 * The check and the warm MUST stay bound to the same cache, which is why they live
 * in one function. `getModels` looks like a warm but answers from a 16-entry LRU
 * whose age renews on every read: once the 6h provider-map file cache lapses while
 * those entries stay hot, `getModels` resolves every id without ever calling
 * `getProviders`, the file is never rewritten, and `onCatalogWarmed` re-fires on
 * every rebuild forever. `getProviders` repopulates exactly what the check reads.
 */
export async function catalogCachedOrWarming(
  onCatalogWarmed: (() => void) | undefined,
  deps?: WarmCatalogDeps,
): Promise<boolean> {
  if (await (deps?.hasCachedModelsCatalog ?? hasCachedModelsCatalog)()) return true;
  // A failed fetch leaves the catalog cold: skip the rebuild rather than spin.
  if (onCatalogWarmed !== undefined) void (deps?.getProviders ?? getProviders)().then(onCatalogWarmed, () => {});
  return false;
}
