import { lookupCachedModel } from '@aio-proxy/core';
import type { DashboardRoutingCatalog } from '@aio-proxy/types';

/**
 * The vendor that made the model, read off the catalog slug's segments.
 *
 * models.dev calls a slug's leading segment a providerId, but in this repo
 * Provider ID means the upstream provider a request is sent to, so the two must
 * never share a name. That segment is also not always a maker: the OpenRouter
 * fallback builds its slug from OpenRouter's own key, so a leading `openrouter`
 * names the channel reselling the model rather than the vendor that made it.
 * A maker is behind that channel segment only when OpenRouter's key was itself
 * vendor-prefixed, leaving three or more segments
 * (`openrouter/anthropic/claude-sonnet-4.5`). With exactly two the key was bare
 * and the second segment is a model id, not a vendor. Naming `openrouter` or a
 * model id as the lab would both stand a fake maker beside the real ones, so the
 * caller gets no catalog instead.
 */
function catalogLab(slug: string): string | undefined {
  const segments = slug.split('/');
  const lab = segments[0] === 'openrouter' ? (segments.length >= 3 ? segments[1] : undefined) : segments[0];
  return lab === undefined || lab === '' ? undefined : lab;
}

/**
 * Objective facts derived from the models.dev catalog.
 *
 * Cache-only, never a network fetch: a cold cache yields `undefined` so callers
 * degrade gracefully instead of failing.
 */
export async function routingCatalogFacts(modelId: string): Promise<DashboardRoutingCatalog | undefined> {
  const entry = await lookupCachedModel(modelId);
  if (entry === undefined) return undefined;
  const lab = catalogLab(entry.slug);
  if (lab === undefined) return undefined;
  // `releaseDate` lives on the catalog-derived capabilities block and is passed
  // through verbatim (`YYYY-MM` or `YYYY-MM-DD`), never parsed into a Date.
  const releaseDate = entry.metadata.capabilities?.releaseDate;
  return { lab, ...(releaseDate === undefined ? {} : { releaseDate }) };
}
