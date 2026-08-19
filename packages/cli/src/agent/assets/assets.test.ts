import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentFiles } from './assets';

test('projects fixed files for each managed target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-assets-'));
  try {
    const paths = {
      opencode: join(root, 'opencode.js'),
      officialPi: join(root, 'official-pi.js'),
      omp: join(root, 'omp.js'),
    };
    for (const [name, path] of Object.entries(paths)) writeFileSync(path, `export default ${JSON.stringify(name)};`);
    expect([...(await agentFiles('opencode', paths))].map(([path]) => path)).toEqual(['index.js', 'package.json']);
    expect([...(await agentFiles('pi', paths))].map(([path]) => path)).toEqual([
      'dist/official-pi.js',
      'dist/omp.js',
      'package.json',
    ]);
    expect([...(await agentFiles('omp', paths))].map(([path]) => path)).toEqual([
      'dist/official-pi.js',
      'dist/omp.js',
      'package.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed Pi-family manifest chooses distinct native entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-assets-'));
  try {
    const paths = {
      opencode: join(root, 'opencode.js'),
      officialPi: join(root, 'official-pi.js'),
      omp: join(root, 'omp.js'),
    };
    for (const path of Object.values(paths)) writeFileSync(path, 'export default () => {};');
    const files = await agentFiles('pi', paths);
    const raw = files.get('package.json');
    if (raw === undefined) throw new Error('missing installed package manifest');
    expect(JSON.parse(new TextDecoder().decode(raw))).toEqual({
      type: 'module',
      pi: { extensions: ['./dist/official-pi.js'] },
      omp: { extensions: ['./dist/omp.js'] },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
