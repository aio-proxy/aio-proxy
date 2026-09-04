import { fetchLatestNpmVersion } from '@aio-proxy/core';
import { Hono } from 'hono';

// The published CLI package is the release channel: the Homebrew tap installs the same
// tarballs, and no GitHub Release asset exists to check against.
const PACKAGE = 'aio-proxy';

export const createDashboardReleaseRoute = (
  version: string,
  fetchLatest: (pkg: string) => Promise<string> = (pkg) => fetchLatestNpmVersion(pkg),
) =>
  new Hono()
    .get('/', (context) => context.json({ current: version }))
    // Registry lookups are a network hop the Settings page must not pay on load, so the
    // check is its own endpoint the user triggers. `Bun.semver` lives here rather than in
    // the browser, which has no semver comparison of its own.
    .get('/latest', async (context) => {
      let latest: string;
      try {
        latest = await fetchLatest(PACKAGE);
      } catch {
        return context.json({ error: { code: 'check_failed' } } as const, 502);
      }
      return context.json({ current: version, latest, outdated: Bun.semver.order(latest, version) > 0 });
    });
