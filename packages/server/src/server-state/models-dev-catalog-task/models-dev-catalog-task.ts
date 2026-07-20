import { createModelsDevCatalog, type FetchModelsDevProviders, type ModelsDevCatalog } from "@aio-proxy/core";

const PRICE_CATALOG_TTL_MS = 6 * 60 * 60 * 1_000;

export function createModelsDevCatalogTask(
  fetchProviders?: FetchModelsDevProviders,
): () => Promise<ModelsDevCatalog | undefined> {
  let catalog: { readonly expiresAt: number; readonly task: Promise<ModelsDevCatalog | undefined> } | undefined;
  return () => {
    const now = Date.now();
    if (catalog === undefined || catalog.expiresAt <= now) {
      catalog = {
        expiresAt: now + PRICE_CATALOG_TTL_MS,
        task: createModelsDevCatalog(fetchProviders).catch((error: unknown) => {
          if (error instanceof Error) return undefined;
          throw error;
        }),
      };
    }
    return catalog.task;
  };
}
