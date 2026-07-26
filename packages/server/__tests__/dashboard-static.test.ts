import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer, directoryDashboardAssets } from '@aio-proxy/server';

import { loopbackServer } from '../src/dashboard-auth/test-support';

const config = { providers: {} } as const;

describe('dashboard static routes', () => {
  test('Given built dashboard assets When dashboard paths are requested Then static app and API are separated', async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-'));
    mkdirSync(join(dir, 'static'));
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div><script src="/dashboard/static/app.js"></script>');
    writeFileSync(join(dir, 'static', 'app.js'), "console.log('dashboard');");
    const app = await createServer({ config, dashboardAssets: directoryDashboardAssets(dir) });

    try {
      // When
      const dashboard = await app.request('/dashboard', undefined, loopbackServer);
      const dashboardSlash = await app.request('/dashboard/', undefined, loopbackServer);
      const asset = await app.request('/dashboard/static/app.js', undefined, loopbackServer);
      const missingAsset = await app.request('/dashboard/static/missing.js', undefined, loopbackServer);
      const frontendRoute = await app.request('/dashboard/providers', undefined, loopbackServer);
      const api = await app.request('/dashboard/api/config', undefined, loopbackServer);
      const missingApi = await app.request('/dashboard/api/missing', undefined, loopbackServer);
      const oldApi = await app.request('/dashboard/config', undefined, loopbackServer);

      // Then
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain('/dashboard/static/app.js');
      expect(dashboardSlash.status).toBe(200);
      expect(await dashboardSlash.text()).toContain('root');
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain('dashboard');
      expect(missingAsset.status).toBe(404);
      expect(frontendRoute.status).toBe(200);
      expect(await frontendRoute.text()).toContain('root');
      expect(api.status).toBe(200);
      expect(await api.json()).toMatchObject({ providers: expect.any(Array) });
      expect(missingApi.status).toBe(404);
      expect(oldApi.status).toBe(200);
      expect(await oldApi.text()).toContain('root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
