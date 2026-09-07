import type { Context } from 'hono';
import { Hono } from 'hono';

import type { DashboardAssets } from '../../dashboard-assets';

/**
 * Serves the built dashboard under `/dashboard`, falling back to `index.html` so a client-side route
 * survives a reload. A missing `static/` asset stays a real 404: answering it with the shell would
 * hand a script tag an HTML body. The `api` catch-alls keep an unmatched API path a 404 rather than
 * letting the shell fallback swallow it.
 *
 * Mounted after the dashboard API routes, so those still win for the paths they declare.
 */
export const createDashboardArtifactRoutes = (dashboardAssets: DashboardAssets): Hono => {
  const serve = async (context: Context) => {
    const assetKey =
      context.req.path === '/dashboard' || context.req.path === '/dashboard/'
        ? 'index.html'
        : context.req.path.replace(/^\/dashboard\//u, '');
    const asset = await dashboardAssets(assetKey);
    if (asset !== null && asset !== undefined) {
      if (assetKey.startsWith('static/')) {
        asset.headers.set('cache-control', 'public, max-age=31536000, immutable');
      }
      return asset;
    }
    if (assetKey.startsWith('static/')) return context.notFound();
    const index = await dashboardAssets('index.html');
    return index ?? context.notFound();
  };

  return new Hono()
    .get('/', serve)
    .all('/api', (context) => context.notFound())
    .all('/api/*', (context) => context.notFound())
    .get('/*', serve)
    .all('/static/*', (context) => context.notFound());
};
