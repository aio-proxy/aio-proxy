import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCatalogV1, AgentManagedStateV1, AgentTarget } from '@aio-proxy/types';

import type { AgentLocation } from '../hosts';
import { inspectManagedInstallation } from './inspect';

const INSPECT_INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const inspectRoots: string[] = [];
afterEach(async () => {
  await Promise.all(inspectRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fCatalog = (): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'opencode',
  models: [
    {
      id: 'gpt-x',
      name: 'GPT X',
      reasoning: false,
      tool_call: true,
      temperature: false,
      attachment: false,
      input: ['text'],
      context_window: 8_192,
      max_output_tokens: 2_048,
    },
  ],
});

async function installationFixture(
  options: {
    readonly symlink?: 'managed directory' | 'marker' | 'OpenCode entry';
    readonly state?: AgentManagedStateV1;
    readonly markerAgent?: AgentTarget;
    readonly entryInstallationId?: string;
    readonly missingEntry?: boolean;
  } = {},
): Promise<{ readonly location: AgentLocation }> {
  const root = await mkdtemp(join(tmpdir(), 'aio-proxy-agent-inspect-'));
  inspectRoots.push(root);
  const hostRoot = join(root, 'plugins');
  const managedDir = join(hostRoot, 'aio-proxy');
  const adjacentEntry = join(hostRoot, 'aio-proxy.js');
  await mkdir(managedDir, { recursive: true });
  const markerPath = join(managedDir, '.aio-proxy-managed.json');
  const marker = {
    format: 1,
    managedBy: 'aio-proxy',
    agent: options.markerAgent ?? 'opencode',
    installationId: INSPECT_INSTALLATION,
    adapterVersion: '1.2.3',
    endpoint: 'http://127.0.0.1:9317',
  } as const;
  await writeFile(markerPath, JSON.stringify(marker));
  if (options.state !== undefined) {
    await writeFile(join(managedDir, '.aio-proxy-state.json'), JSON.stringify(options.state));
  }
  const entryId = options.entryInstallationId ?? INSPECT_INSTALLATION;
  if (options.missingEntry !== true) {
    await writeFile(
      adjacentEntry,
      `// aio-proxy-managed:v1:${entryId}\nexport { default } from "./aio-proxy/index.js";\n`,
    );
  }
  if (options.symlink === 'managed directory') {
    const real = join(hostRoot, 'real-aio-proxy');
    await rename(managedDir, real);
    await symlink(real, managedDir, 'dir');
  } else if (options.symlink === 'marker') {
    const real = join(root, 'marker.json');
    await writeFile(real, JSON.stringify(marker));
    await rm(markerPath);
    await symlink(real, markerPath, 'file');
  } else if (options.symlink === 'OpenCode entry') {
    const real = join(root, 'entry.js');
    await writeFile(real, await Bun.file(adjacentEntry).text());
    await rm(adjacentEntry);
    await symlink(real, adjacentEntry, 'file');
  }
  return { location: { target: 'opencode', hostRoot, managedDir, adjacentEntry } };
}

test.each(['managed directory', 'marker', 'OpenCode entry'] as const)('%s symlink is a conflict', async (kind) => {
  const f = await installationFixture({ symlink: kind });
  await expect(inspectManagedInstallation(f.location, () => Date.parse('2026-08-18T00:05:00Z'))).resolves.toMatchObject(
    {
      integration: 'conflict',
      reason: 'symlink',
    },
  );
});

test('valid marker plus old successful state reports stale after ten minutes', async () => {
  const f = await installationFixture({
    state: {
      format: 1,
      catalogSchema: 1,
      status: 'fresh',
      lastSuccessfulAt: '2026-08-18T00:00:00.000Z',
      lastError: null,
      lkg: fCatalog(),
    },
  });
  await expect(
    inspectManagedInstallation(f.location, () => Date.parse('2026-08-18T00:10:00.001Z')),
  ).resolves.toMatchObject({ integration: 'managed', catalog: 'stale' });
});

test('OpenCode entry must match the marker installation byte-for-byte', async () => {
  const f = await installationFixture({ entryInstallationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  await expect(inspectManagedInstallation(f.location, Date.now)).resolves.toMatchObject({
    integration: 'conflict',
    reason: 'entry_invalid',
  });
});

test('a legal OpenCode marker exposes a missing adjacent entry as repairable state', async () => {
  const f = await installationFixture({ missingEntry: true });
  await expect(inspectManagedInstallation(f.location, Date.now)).resolves.toMatchObject({
    integration: 'managed',
    entry: 'missing',
    catalog: 'missing',
  });
});

test('a schema-valid marker for another target is a marker conflict', async () => {
  const f = await installationFixture({ markerAgent: 'pi' });
  await expect(inspectManagedInstallation(f.location, Date.now)).resolves.toMatchObject({
    integration: 'conflict',
    reason: 'marker_invalid',
  });
});
