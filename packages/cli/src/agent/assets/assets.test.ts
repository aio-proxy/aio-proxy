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
    const decode = (files: ReadonlyMap<string, Uint8Array>, path: string): string => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error(`missing ${path}`);
      return new TextDecoder().decode(raw);
    };
    const opencode = await agentFiles('opencode', paths);
    const pi = await agentFiles('pi', paths);
    const omp = await agentFiles('omp', paths);
    expect([...opencode.keys()]).toEqual(['index.js', 'package.json']);
    expect([...pi.keys()]).toEqual(['index.js', 'package.json']);
    expect([...omp.keys()]).toEqual(['index.js', 'package.json']);
    expect(decode(pi, 'index.js')).toBe('export default "officialPi";');
    expect(decode(omp, 'index.js')).toBe('export default "omp";');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each host manifest points at its own index entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-assets-'));
  try {
    const paths = {
      opencode: join(root, 'opencode.js'),
      officialPi: join(root, 'official-pi.js'),
      omp: join(root, 'omp.js'),
    };
    for (const path of Object.values(paths)) writeFileSync(path, 'export default () => {};');
    const manifest = async (target: 'pi' | 'omp') => {
      const raw = (await agentFiles(target, paths)).get('package.json');
      if (raw === undefined) throw new Error('missing installed package manifest');
      return JSON.parse(new TextDecoder().decode(raw));
    };
    expect(await manifest('pi')).toEqual({ type: 'module', pi: { extensions: ['./index.js'] } });
    expect(await manifest('omp')).toEqual({ type: 'module', omp: { extensions: ['./index.js'] } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
