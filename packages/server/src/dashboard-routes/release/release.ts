import { fetchLatestNpmVersion, readUpdateCheckState, writeUpdateCheckState } from '@aio-proxy/core';
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

const persistLatest = async (latest: string): Promise<void> => {
  const previous = readUpdateCheckState();
  await writeUpdateCheckState({
    latest,
    checkedAt: Date.now(),
    ...(previous?.notifiedVersion === undefined ? {} : { notifiedVersion: previous.notifiedVersion }),
  });
};

export const createDashboardReleaseRoute = (
  version: string,
  fetchLatest: (pkg: string) => Promise<string> = (pkg) => fetchLatestNpmVersion(pkg),
  controller?: AutoUpdateController,
) =>
  new Hono()
    .get('/', (context) => {
      const snap = controller?.snapshot();
      return context.json({
        current: version,
        outdated: snap?.outdated ?? false,
        managedService: controller?.isManagedService() ?? false,
        update: { status: snap?.status ?? 'idle' },
        ...(snap?.latest === undefined ? {} : { latest: snap.latest }),
      });
    })
    .get('/latest', async (context) => {
      if (controller !== undefined) {
        const result = await controller.check();
        if ('status' in result) return context.json({ error: { code: 'check_failed' } } as const, 502);
        return context.json(result);
      }
      let latest: string;
      try {
        latest = await fetchLatest(PACKAGE);
        Bun.semver.order(latest, version);
        await persistLatest(latest);
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
