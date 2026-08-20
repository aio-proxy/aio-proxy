import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { defaultCliDeps, devDashboardStaticDir, embeddedDashboardAssets } from './dashboard-assets';

describe('devDashboardStaticDir', () => {
  test('Given built dashboard When resolving Then returns dir containing index.html', async () => {
    const dir = devDashboardStaticDir();
    expect(await Bun.file(`${dir}/index.html`).exists()).toBe(true);
  });
});

describe('embeddedDashboardAssets', () => {
  test('Given a file map When hit and miss Then serves file or returns null', async () => {
    const tmp = `${import.meta.dir}/dashboard-assets.test.ts`;
    const assets = embeddedDashboardAssets({ 'index.html': tmp });
    const hit = await assets('index.html');
    expect(hit).not.toBeNull();
    expect(await hit?.text()).toContain('embeddedDashboardAssets');
    expect(await assets('missing.js')).toBeNull();
  });
});

describe('defaultCliDeps.agentAssetPaths', () => {
  test('Given built adapter artifacts When resolving Then returns the three exported files', async () => {
    const paths = defaultCliDeps.agentAssetPaths();
    expect(paths).toEqual({
      opencode: fileURLToPath(import.meta.resolve('@aio-proxy/opencode-provider/artifact')),
      officialPi: fileURLToPath(import.meta.resolve('@aio-proxy/pi-provider/official-pi-artifact')),
      omp: fileURLToPath(import.meta.resolve('@aio-proxy/pi-provider/omp-artifact')),
    });
    expect(await Bun.file(paths.opencode).exists()).toBe(true);
    expect(await Bun.file(paths.officialPi).exists()).toBe(true);
    expect(await Bun.file(paths.omp).exists()).toBe(true);
  });
});
