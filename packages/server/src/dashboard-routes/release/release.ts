import { fetchLatestNpmVersion } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { AutoUpdateApplyResult, AutoUpdateController } from '../../auto-update';

// The published CLI package is the release channel: the Homebrew tap installs the same
// tarballs, and no GitHub Release asset exists to check against.
const PACKAGE = 'aio-proxy';

const APPLY_HTTP = {
  started: 202,
  up_to_date: 200,
  in_progress: 409,
  unavailable: 501,
  check_failed: 502,
} as const satisfies Record<AutoUpdateApplyResult['status'], 200 | 202 | 409 | 501 | 502>;

export const createDashboardReleaseRoute = (
  version: string,
  fetchLatest: (pkg: string) => Promise<string> = (pkg) => fetchLatestNpmVersion(pkg),
  controller?: AutoUpdateController,
) =>
  new Hono()
    .get('/', (context) =>
      context.json({
        current: version,
        managedService: controller?.isManagedService() ?? false,
        update: controller?.snapshot() ?? { status: 'idle' },
      }),
    )
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
    })
    .post('/apply', async (context) => {
      const result = (await controller?.apply()) ?? { status: 'unavailable' as const };
      const status = APPLY_HTTP[result.status];
      if (result.status === 'started' || result.status === 'up_to_date') {
        return context.json({ ok: true, status: result.status } as const, status);
      }
      return context.json({ ok: false, error: { code: result.status } } as const, status);
    });
