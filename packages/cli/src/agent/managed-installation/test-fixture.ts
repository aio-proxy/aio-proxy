import { mock } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type { AgentCatalogV1, AgentManagedStateV1, AgentTarget } from '@aio-proxy/types';

import type { AgentLocation } from '../hosts';
import { openCodeEntry } from './inspect';
import type { ManagedInstallInput, ManagedInstallTestDeps } from './install';

export const INSTALL_ID = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
export const fixtureRoots: string[] = [];

export { openCodeEntry };

export const fixtureCatalog = (agent: AgentTarget): AgentCatalogV1 => ({
  schema_version: 1,
  agent,
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

export const validState = (agent: AgentTarget = 'pi'): AgentManagedStateV1 => ({
  format: 1,
  catalogSchema: 1,
  status: 'fresh',
  lastSuccessfulAt: '2026-08-18T00:00:00.000Z',
  lastError: null,
  lkg: fixtureCatalog(agent),
});

export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result[relative(root, absolute)] = await readFile(absolute, 'utf8');
    }
  };
  await visit(root);
  return result;
}

export async function installFixture(
  target: AgentTarget,
  options: {
    readonly existing?: boolean;
    readonly state?: AgentManagedStateV1;
    readonly adapterVersion?: string;
    readonly missingEntry?: boolean;
    readonly failure?: 'stage write' | 'directory swap' | 'OpenCode entry write';
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'aio-proxy-agent-install-'));
  fixtureRoots.push(root);
  const hostRoot = join(root, target === 'opencode' ? 'plugins' : 'extensions');
  const managedDir = join(hostRoot, 'aio-proxy');
  const location: AgentLocation = {
    target,
    hostRoot,
    managedDir,
    ...(target === 'opencode' ? { adjacentEntry: join(hostRoot, 'aio-proxy.js') } : {}),
  };
  await mkdir(hostRoot, { recursive: true });
  if (options.existing === true) {
    await mkdir(managedDir);
    await writeFile(join(managedDir, 'old.js'), 'old-adapter');
    await writeFile(join(managedDir, 'user-edit.txt'), 'replace-me');
    await writeFile(
      join(managedDir, '.aio-proxy-managed.json'),
      JSON.stringify({
        format: 1,
        managedBy: 'aio-proxy',
        agent: target,
        installationId: INSTALL_ID,
        adapterVersion: options.adapterVersion ?? '1.0.0',
        endpoint: 'http://127.0.0.1:9317',
      }),
    );
    if (options.state !== undefined) {
      await writeFile(join(managedDir, '.aio-proxy-state.json'), JSON.stringify(options.state));
    }
    if (location.adjacentEntry !== undefined && options.missingEntry !== true) {
      await writeFile(location.adjacentEntry, openCodeEntry(INSTALL_ID));
    }
  }
  const readAssets = mock(
    async () =>
      new Map<string, Uint8Array>([
        ['index.js', new TextEncoder().encode(`built-${target === 'opencode' ? 'opencode' : target}`)],
        ['package.json', new TextEncoder().encode('{"type":"module"}\n')],
      ]),
  );
  const input: ManagedInstallInput = {
    location,
    endpoint: 'http://127.0.0.1:9317',
    adapterVersion: '2.0.0',
    requestedInstallationId: INSTALL_ID,
    readAssets,
  };
  const failpointByFailure = {
    'stage write': 'staged',
    'directory swap': 'backed_up',
    'OpenCode entry write': 'directory_swapped',
  } as const;
  const failure = options.failure;
  const deps: ManagedInstallTestDeps = {
    ...(failure === undefined
      ? {}
      : {
          failpoint: (point) => {
            if (point === failpointByFailure[failure]) throw new Error(failure);
          },
        }),
  };
  return {
    root,
    location,
    input,
    deps,
    installationId: INSTALL_ID,
    readAssets,
    beforeTree: await snapshotTree(root),
    tree: () => snapshotTree(root),
  };
}

export async function onlyPrefixed(directory: string, prefix: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => name.startsWith(prefix));
  if (names.length !== 1) throw new Error(`expected one ${prefix}* in ${directory}, found ${names.join(', ')}`);
  return join(directory, names[0]);
}

export async function displaceAndReplaceDir(path: string, displaced: string, child: string, contents: string) {
  await rename(path, displaced);
  await mkdir(path);
  await writeFile(join(path, child), contents);
}

export async function displaceAndReplaceFile(path: string, displaced: string, contents: string) {
  await rename(path, displaced);
  await writeFile(path, contents);
}

export async function removeFixture(target: AgentTarget, options: { readonly conflictingEntry?: boolean } = {}) {
  const fixture = await installFixture(target, { existing: true });
  if (options.conflictingEntry === true && fixture.location.adjacentEntry !== undefined) {
    await writeFile(fixture.location.adjacentEntry, 'user-owned entry');
  }
  return { ...fixture, beforeTree: await snapshotTree(fixture.root) };
}
