import { lookupCachedModel } from '@aio-proxy/core';
import type { DashboardRoutingCatalog } from '@aio-proxy/types';

/**
 * Objective facts derived from the models.dev catalog.
 *
 * `lab` is the model's vendor (openai, anthropic) and comes from the prefix of
 * the catalog slug. models.dev calls that prefix a providerId, but in this repo
 * Provider ID means the upstream provider a request is sent to, so the two must
 * never share a name.
 *
 * Cache-only, never a network fetch: a cold cache yields `undefined` so callers
 * degrade gracefully instead of failing.
 */
export async function routingCatalogFacts(modelId: string): Promise<DashboardRoutingCatalog | undefined> {
  const entry = await lookupCachedModel(modelId);
  if (entry === undefined) return undefined;
  const lab = entry.slug.split('/')[0];
  if (lab === undefined || lab === '') return undefined;
  // `releaseDate` lives on the catalog-derived capabilities block and is passed
  // through verbatim (`YYYY-MM` or `YYYY-MM-DD`), never parsed into a Date.
  const releaseDate = entry.metadata.capabilities?.releaseDate;
  return { lab, ...(releaseDate === undefined ? {} : { releaseDate }) };
}
