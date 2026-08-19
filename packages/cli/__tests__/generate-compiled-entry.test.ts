import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listAssetPaths, renderCompiledEntry, virtualCompiledEntry } from '../scripts/generate-compiled-entry';

describe('listAssetPaths', () => {
  test('Given nested dist When listing Then returns sorted slash-separated relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-gen-'));
    mkdirSync(join(dir, 'static', 'js'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), 'x');
    writeFileSync(join(dir, 'static', 'js', 'app.js'), 'x');
    try {
      expect(listAssetPaths(dir)).toEqual(['index.html', 'static/js/app.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderCompiledEntry', () => {
  test('Given asset paths When rendering Then emits file-type imports and the asset map', () => {
    const code = renderCompiledEntry(['index.html', 'static/js/app.js']);
    expect(code).toContain('import asset0 from "@aio-proxy/dashboard/dist/index.html" with { type: "file" };');
    expect(code).toContain('import asset1 from "@aio-proxy/dashboard/dist/static/js/app.js" with { type: "file" };');
    expect(code).toContain('"static/js/app.js": asset1,');
    expect(code).toContain('import { embeddedDashboardAssets } from "./dashboard-assets";');
    expect(code).toContain('import { main } from "./main";');
    expect(code).toContain(
      'import opencodeProvider from "@aio-proxy/opencode-provider/artifact" with { type: "file" };',
    );
    expect(code).toContain(
      'import officialPiProvider from "@aio-proxy/pi-provider/official-pi-artifact" with { type: "file" };',
    );
    expect(code).toContain('import ompProvider from "@aio-proxy/pi-provider/omp-artifact" with { type: "file" };');
    expect(code).toContain(
      'agentAssetPaths: () => ({ opencode: opencodeProvider, officialPi: officialPiProvider, omp: ompProvider })',
    );
    expect(code).toContain('dashboardAssets: () => embeddedDashboardAssets(files),');
  });
});

describe('virtualCompiledEntry', () => {
  test('Given asset paths When creating a virtual entry Then returns the entry path and in-memory source', () => {
    const entry = virtualCompiledEntry(['index.html']);

    expect(entry.entrypoint).toEndWith(join('packages', 'cli', 'src', 'main.compiled.gen.ts'));
    expect(Object.keys(entry.files)).toEqual([entry.entrypoint]);
    expect(entry.files[entry.entrypoint]).toContain(
      'import opencodeProvider from "@aio-proxy/opencode-provider/artifact" with { type: "file" };',
    );
    expect(entry.files[entry.entrypoint]).toContain(
      'agentAssetPaths: () => ({ opencode: opencodeProvider, officialPi: officialPiProvider, omp: ompProvider })',
    );
    expect(entry.files[entry.entrypoint]).toContain('dashboardAssets: () => embeddedDashboardAssets(files),');
  });
});
