# Agent CLI Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `aio-proxy agent list/configure/remove/revoke`, atomically install the bundled OpenCode and Pi-family providers, and update already-managed integrations with the newly installed binary after `aio-proxy upgrade`.

**Architecture:** The compiled CLI embeds three built JavaScript assets and exposes them through its existing dependency bundle. A narrow Agent CLI domain resolves each host's public global path, validates ownership marker/adjacent-entry state, and applies fixed atomic filesystem operations. Online list/revoke operations use the running loopback control plane; upgrade hands pre-resolved targets to the newly installed binary so adapter bytes always match the new aio-proxy version.

**Tech Stack:** Bun 1.3.14, TypeScript, Commander 15, Zod 4 contracts from `@aio-proxy/types`, Bun compiled assets, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-18-agent-provider-integrations-design.md`

## Global Constraints

- Commands are exactly:
  - `aio-proxy agent list [--check] [--authorizations] [--json]`
  - `aio-proxy agent configure <opencode|pi|omp>`
  - `aio-proxy agent remove <opencode|pi|omp>`
  - `aio-proxy agent revoke <installation-id>`
- `configure` and `remove` require one explicit target. Do not add configure-all, project-local installation, profile enumeration, or a force-remove path.
- Required floors are OpenCode `1.17.10`, official Pi `0.84.2`, and OMP `17.3.7`. Older/unknown versions warn and install; a missing host fails configure without writing.
- OpenCode config root comes from `opencode debug paths` (`config` row). Official Pi uses `PI_CODING_AGENT_DIR` or `~/.pi/agent`. OMP uses `omp config path`, which already honors `OMP_PROFILE` and the active profile.
- Managed directories are fixed direct children of those roots. Never scan project directories or other profiles.
- Marker, target directory, and OpenCode adjacent-entry validation happens before overwrite, revoke-for-remove, or deletion. A symlink target/marker/entry is a conflict.
- OpenCode installs `plugins/aio-proxy/` plus the fixed adjacent `plugins/aio-proxy.js`. Pi/OMP install only `extensions/aio-proxy/`.
- Preserve only a schema-1-valid `.aio-proxy-state.json` during an update. All other bytes inside a valid managed directory are replaceable.
- A newer on-disk adapter version is never downgraded and its adapter assets are never read. For OpenCode only, a missing fixed adjacent entry is repaired atomically from the legal marker even when the adapter is newer; a present valid entry is untouched.
- `remove` first obtains `revoked`, `expired`, or `missing` from the running loopback admin endpoint, then deletes only validated local artifacts. Network/5xx errors leave every local file intact.
- Do not read or modify any host config/auth file. Do not install/upgrade/start a host or aio-proxy server.
- Endpoint is an HTTP loopback URL derived from the current runtime config. Normalize wildcard bind hosts to loopback; reject explicit non-loopback binds.
- Default `agent list` is local-only. A missing host or failed public path command reports `unresolved`, never `absent`. `--check` performs one capability-snapshot request. `--authorizations` implies `--check` and lists orphan server identities without reading any host credential.
- Embedded adapter files are the only supported source. Configure/post-upgrade never run npm/bun install or download provider code.
- `aio-proxy upgrade` invokes the newly installed binary for post-upgrade adapter updates. The old process must never write old embedded bytes after installation succeeds.
- Post-upgrade touches only pre-resolved targets whose paths and legal markers are revalidated. It never creates integrations or revokes identities; one failed adapter update warns and does not roll back aio-proxy.
- A direct root invocation warns and updates only the effective root user's paths. Do not inspect `SUDO_USER` or guess another user's home; Windows Administrator detection is outside the current published platform matrix.
- User-facing copy is present in all five locale files and shell completion includes `agent`.
- Add all three new private packages to the Changesets fixed group and create one user-facing Changeset targeting `aio-proxy` plus every actually modified workspace package at the same bump level.
- Handwritten non-test implementation files remain below 500 lines.
- Every commit appends `Co-authored-by: Codex <noreply@openai.com>`.

---

## File Structure

- `packages/cli/src/agent/assets/` — fixed embedded file paths and minimal installed package manifests.
- `packages/cli/src/agent/hosts/` — host detection, version classification, and one global path resolver per target.
- `packages/cli/src/agent/managed-installation/` — marker/entry inspection, LKG preservation, atomic install, and validated deletion.
- `packages/cli/src/agent/control-plane/` — capability snapshot and idempotent revoke HTTP calls.
- `packages/cli/src/agent/agent.ts` — command orchestration and typed results.
- `packages/cli/src/agent/output.ts` — localized text and exact one-line JSON rendering for Commander actions.
- `packages/cli/src/agent/index.ts` — export-only Agent command barrel.
- `packages/cli/src/upgrade/post-upgrade-agents.ts` — payload validation and new-binary managed-only update action.
- `packages/cli/scripts/generate-compiled-entry.ts` — Dashboard plus three adapter `type: file` imports.
- `packages/cli/src/dashboard-assets.ts` — shared CLI dependency object carrying Dashboard and Agent asset paths in dev/compiled modes.
- `packages/cli/src/main.ts` — public `agent` commands and hidden post-upgrade action.
- `packages/cli/src/completion/scripts.ts` — top-level `agent` completion.
- `packages/i18n/messages/*.json` — five-locale Agent lifecycle copy.
- `README.md` and release notes/Changeset — user contract and release metadata.

### Task 1: Embed the three adapter artifacts in every compiled CLI

**Files:**

- Create: `packages/cli/src/agent/assets/index.ts`
- Create: `packages/cli/src/agent/assets/assets.ts`
- Test: `packages/cli/src/agent/assets/assets.test.ts`
- Modify: `packages/cli/src/dashboard-assets.ts`
- Modify: `packages/cli/src/dashboard-assets.test.ts`
- Modify: `packages/cli/scripts/generate-compiled-entry.ts`
- Modify: `packages/cli/__tests__/generate-compiled-entry.test.ts`
- Modify: `packages/cli/__tests__/binary-build.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/opencode-provider/package.json`
- Modify: `packages/pi-provider/package.json`
- Modify: `bun.lock`

**Interfaces:**

- Produces `AgentAssetPaths = { opencode: string; officialPi: string; omp: string }`, `agentFiles(target, paths): Promise<ReadonlyMap<string, Uint8Array>>`, and `CliDeps.agentAssetPaths()`.
- Consumes the already-built adapter artifacts through private package export subpaths.

- [ ] **Step 1: Write failing asset-boundary tests**

```ts
// packages/cli/src/agent/assets/assets.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFiles } from './assets';

test('projects fixed files for each managed target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-assets-'));
  try {
    const paths = {
      opencode: join(root, 'opencode.js'), officialPi: join(root, 'official-pi.js'), omp: join(root, 'omp.js'),
    };
    for (const [name, path] of Object.entries(paths)) writeFileSync(path, `export default ${JSON.stringify(name)};`);
    expect([...await agentFiles('opencode', paths)].map(([path]) => path)).toEqual(['index.js', 'package.json']);
    expect([...await agentFiles('pi', paths)].map(([path]) => path)).toEqual([
      'dist/official-pi.js', 'dist/omp.js', 'package.json',
    ]);
    expect([...await agentFiles('omp', paths)].map(([path]) => path)).toEqual([
      'dist/official-pi.js', 'dist/omp.js', 'package.json',
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
```

Extend `generate-compiled-entry.test.ts` to assert exactly three additional file imports and this dependency payload:

```ts
expect(source).toContain('import opencodeProvider from "@aio-proxy/opencode-provider/artifact" with { type: "file" };');
expect(source).toContain('import officialPiProvider from "@aio-proxy/pi-provider/official-pi-artifact" with { type: "file" };');
expect(source).toContain('import ompProvider from "@aio-proxy/pi-provider/omp-artifact" with { type: "file" };');
expect(source).toContain('agentAssetPaths: () => ({ opencode: opencodeProvider, officialPi: officialPiProvider, omp: ompProvider })');
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test packages/cli/src/agent/assets/assets.test.ts packages/cli/__tests__/generate-compiled-entry.test.ts`

Expected: FAIL because Agent assets are not embedded.

- [ ] **Step 3: Add private artifact exports and CLI dependencies**

Add these package exports without changing their existing source export:

```jsonc
// packages/opencode-provider/package.json
"exports": {
  ".": "./src/index.ts",
  "./artifact": "./dist/index.js"
}
```

```jsonc
// packages/pi-provider/package.json
"exports": {
  "./official-pi-artifact": "./dist/official-pi.js",
  "./omp-artifact": "./dist/omp.js"
}
```

Declare both private packages as `workspace:*` dependencies of `@aio-proxy/cli`. Their artifacts must be built before `build:binary`; do not publish them independently.

- [ ] **Step 4: Implement fixed asset projection**

```ts
// packages/cli/src/agent/assets/assets.ts
import type { AgentTarget } from '@aio-proxy/types';

export type AgentAssetPaths = {
  readonly opencode: string;
  readonly officialPi: string;
  readonly omp: string;
};

const json = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

const bytes = async (path: string): Promise<Uint8Array> => {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Agent adapter asset not found: ${path}`);
  return file.bytes();
};

export async function agentFiles(
  target: AgentTarget,
  paths: AgentAssetPaths,
): Promise<ReadonlyMap<string, Uint8Array>> {
  if (target === 'opencode') {
    return new Map([
      ['index.js', await bytes(paths.opencode)],
      ['package.json', json({ type: 'module' })],
    ]);
  }
  return new Map([
    ['dist/official-pi.js', await bytes(paths.officialPi)],
    ['dist/omp.js', await bytes(paths.omp)],
    ['package.json', json({
      type: 'module',
      pi: { extensions: ['./dist/official-pi.js'] },
      omp: { extensions: ['./dist/omp.js'] },
    })],
  ]);
}
```

`assets/index.ts` explicitly exports `AgentAssetPaths` and `agentFiles`.

- [ ] **Step 5: Extend dev and compiled dependency injection**

Add `readonly agentAssetPaths: () => AgentAssetPaths` to `CliDeps`. Dev mode resolves the three exported artifact URLs with `fileURLToPath(import.meta.resolve(...))`. `renderCompiledEntry` emits the three fixed `type: file` imports after Dashboard imports and passes both dependencies:

```ts
await main({
  dashboardAssets: () => embeddedDashboardAssets(files),
  agentAssetPaths: () => ({
    opencode: opencodeProvider,
    officialPi: officialPiProvider,
    omp: ompProvider,
  }),
});
```

Keep Dashboard asset enumeration unchanged; adapter assets are fixed names, not another recursive asset scanner.

- [ ] **Step 6: Run asset and one binary smoke test GREEN**

Run: `bun run --filter @aio-proxy/opencode-provider build && bun run --filter @aio-proxy/pi-provider build && bun test packages/cli/src/agent/assets packages/cli/__tests__/generate-compiled-entry.test.ts packages/cli/__tests__/binary-build.test.ts`

Expected: PASS; the compiled test binary can read all three embedded file paths after source `dist/` directories are hidden by the test.

- [ ] **Step 7: Commit**

```bash
git add packages/cli packages/opencode-provider/package.json packages/pi-provider/package.json bun.lock
git commit -m "feat(cli): embed agent provider artifacts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Host detection, path resolution, and local status

**Files:**

- Create: `packages/cli/src/agent/hosts/index.ts`
- Create: `packages/cli/src/agent/hosts/hosts.ts`
- Test: `packages/cli/src/agent/hosts/hosts.test.ts`
- Create: `packages/cli/src/agent/managed-installation/index.ts`
- Create: `packages/cli/src/agent/managed-installation/inspect.ts`
- Test: `packages/cli/src/agent/managed-installation/inspect.test.ts`

**Interfaces:**

- Produces `detectAgentHost(target, deps): Promise<AgentHost>`, `resolveAgentLocation(target, deps): Promise<AgentLocation>`, `inspectManagedInstallation(location, now): Promise<LocalIntegrationStatus>`.
- Consumes only public host commands/environment rules and Task 1 wire schemas.

```ts
export type AgentHostDeps = {
  readonly which: (name: string) => string | null;
  readonly capture: (command: readonly [string, ...string[]]) => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
};
export type AgentHost = {
  readonly target: AgentTarget;
  readonly detected: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly minimumVersion: string;
  readonly support: 'supported' | 'unsupported' | 'unknown';
};
export type AgentLocation = {
  readonly target: AgentTarget;
  readonly hostRoot: string;
  readonly managedDir: string;
  readonly adjacentEntry?: string;
};
export type LocalIntegrationStatus = {
  readonly integration: 'absent' | 'managed' | 'conflict';
  readonly marker?: AgentManagedMarker;
  readonly entry?: 'present' | 'missing';
  readonly catalog: 'fresh' | 'stale' | 'missing';
  readonly lastSuccessfulAt?: string;
  readonly reason?: 'symlink' | 'marker_missing' | 'marker_invalid' | 'entry_invalid';
};
```

- [ ] **Step 1: Write failing host/path tests**

```ts
// packages/cli/src/agent/hosts/hosts.test.ts
import { expect, test } from 'bun:test';
import { detectAgentHost, resolveAgentLocation, type AgentHostDeps } from './hosts';

const hostFixture = (options: {
  readonly versionOutput?: string;
  readonly capture?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly detected?: boolean;
} = {}): AgentHostDeps => ({
  which: (name) => options.detected === false ? null : `/usr/local/bin/${name}`,
  capture: async (command) => command.includes('--version')
    ? (options.versionOutput ?? '1.17.10')
    : (options.capture ?? ''),
  env: options.env ?? {},
  home: options.home ?? '/tmp/home',
});

test.each([
  ['opencode', '1.17.10', 'supported', '1.17.10'],
  ['opencode', '1.17.9', 'unsupported', '1.17.10'],
  ['pi', '0.84.2', 'supported', '0.84.2'],
  ['pi', '0.83.0', 'unsupported', '0.84.2'],
  ['omp', 'omp/17.3.7', 'supported', '17.3.7'],
  ['omp', 'omp/17.3.6', 'unsupported', '17.3.7'],
  ['omp', 'nightly', 'unknown', '17.3.7'],
] as const)('%s classifies %s as %s', async (target, output, support, minimumVersion) => {
  const host = await detectAgentHost(target, hostFixture({ versionOutput: output }));
  expect(host).toMatchObject({ detected: true, support, minimumVersion });
});

test('OpenCode parses only the config row from debug paths', async () => {
  const location = await resolveAgentLocation('opencode', hostFixture({
    capture: ['home /tmp/home', 'config /tmp/opencode-config', 'state /tmp/state'].join('\n'),
  }));
  expect(location).toEqual({
    target: 'opencode',
    hostRoot: '/tmp/opencode-config/plugins',
    managedDir: '/tmp/opencode-config/plugins/aio-proxy',
    adjacentEntry: '/tmp/opencode-config/plugins/aio-proxy.js',
  });
});

test('official Pi honors only its documented agent-dir override', async () => {
  expect((await resolveAgentLocation('pi', hostFixture({
    env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent', OMP_PROFILE: 'ignored' }, home: '/tmp/home',
  }))).managedDir).toBe('/tmp/pi-agent/extensions/aio-proxy');
});

test.each([
  ['', '/tmp/home/.pi/agent/extensions/aio-proxy'],
  ['~', '/tmp/home/extensions/aio-proxy'],
  ['~/pi-agent', '/tmp/home/pi-agent/extensions/aio-proxy'],
] as const)('official Pi resolves agent-dir override %j like the host', async (override, expected) => {
  expect((await resolveAgentLocation('pi', hostFixture({
    env: { PI_CODING_AGENT_DIR: override }, home: '/tmp/home',
  }))).managedDir).toBe(expected);
});

test('OMP delegates active profile resolution to omp config path', async () => {
  expect((await resolveAgentLocation('omp', hostFixture({ capture: '/tmp/omp-profile/agent\n' }))).managedDir)
    .toBe('/tmp/omp-profile/agent/extensions/aio-proxy');
});
```

- [ ] **Step 2: Write failing conflict/LKG tests**

```ts
// packages/cli/src/agent/managed-installation/inspect.test.ts
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCatalogV1, AgentManagedStateV1 } from '@aio-proxy/types';
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
  models: [{ id: 'gpt-x', name: 'GPT X', reasoning: false, tool_call: true,
    temperature: false, attachment: false, input: ['text'], context_window: 8_192,
    max_output_tokens: 2_048 }],
});

async function installationFixture(options: {
  readonly symlink?: 'managed directory' | 'marker' | 'OpenCode entry';
  readonly state?: AgentManagedStateV1;
  readonly entryInstallationId?: string;
  readonly missingEntry?: boolean;
} = {}): Promise<{ readonly location: AgentLocation }> {
  const root = await mkdtemp(join(tmpdir(), 'aio-proxy-agent-inspect-'));
  inspectRoots.push(root);
  const hostRoot = join(root, 'plugins');
  const managedDir = join(hostRoot, 'aio-proxy');
  const adjacentEntry = join(hostRoot, 'aio-proxy.js');
  await mkdir(managedDir, { recursive: true });
  const markerPath = join(managedDir, '.aio-proxy-managed.json');
  const marker = {
    format: 1, managedBy: 'aio-proxy', agent: 'opencode',
    installationId: INSPECT_INSTALLATION, adapterVersion: '1.2.3',
    endpoint: 'http://127.0.0.1:9317',
  } as const;
  await writeFile(markerPath, JSON.stringify(marker));
  if (options.state !== undefined) {
    await writeFile(join(managedDir, '.aio-proxy-state.json'), JSON.stringify(options.state));
  }
  const entryId = options.entryInstallationId ?? INSPECT_INSTALLATION;
  if (options.missingEntry !== true) {
    await writeFile(adjacentEntry,
      `// aio-proxy-managed:v1:${entryId}\nexport { default } from "./aio-proxy/index.js";\n`);
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
  await expect(inspectManagedInstallation(f.location, () => Date.parse('2026-08-18T00:05:00Z')))
    .resolves.toMatchObject({ integration: 'conflict', reason: 'symlink' });
});

test('valid marker plus old successful state reports stale after ten minutes', async () => {
  const f = await installationFixture({
    state: { format: 1, catalogSchema: 1, status: 'fresh',
      lastSuccessfulAt: '2026-08-18T00:00:00.000Z', lastError: null, lkg: fCatalog() },
  });
  await expect(inspectManagedInstallation(f.location, () => Date.parse('2026-08-18T00:10:00.001Z')))
    .resolves.toMatchObject({ integration: 'managed', catalog: 'stale' });
});

test('OpenCode entry must match the marker installation byte-for-byte', async () => {
  const f = await installationFixture({ entryInstallationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  await expect(inspectManagedInstallation(f.location, Date.now))
    .resolves.toMatchObject({ integration: 'conflict', reason: 'entry_invalid' });
});

test('a legal OpenCode marker exposes a missing adjacent entry as repairable state', async () => {
  const f = await installationFixture({ missingEntry: true });
  await expect(inspectManagedInstallation(f.location, Date.now)).resolves.toMatchObject({
    integration: 'managed', entry: 'missing', catalog: 'missing',
  });
});
```

- [ ] **Step 3: Run tests to verify RED**

Run: `bun test packages/cli/src/agent/hosts packages/cli/src/agent/managed-installation/inspect.test.ts`

Expected: FAIL because host and marker inspection do not exist.

- [ ] **Step 4: Implement exact public host resolution**

```ts
// packages/cli/src/agent/hosts/hosts.ts
import { isAbsolute, join } from 'node:path';
import type { AgentTarget } from '@aio-proxy/types';

const hostCommand = {
  opencode: { executable: 'opencode', versionArgs: ['--version'], floor: '1.17.10' },
  pi: { executable: 'pi', versionArgs: ['--version'], floor: '0.84.2' },
  omp: { executable: 'omp', versionArgs: ['--version'], floor: '17.3.7' },
} as const;

const parseVersion = (target: AgentTarget, output: string): string | undefined => {
  const value = output.trim();
  const candidate = value.startsWith(`${target}/`) ? value.slice(target.length + 1) : value;
  try {
    Bun.semver.order(candidate, candidate);
    return candidate;
  } catch {
    return undefined;
  }
};

export async function detectAgentHost(
  target: AgentTarget,
  deps: AgentHostDeps,
): Promise<AgentHost> {
  const command = hostCommand[target];
  const executable = deps.which(command.executable);
  if (executable === null) {
    return { target, detected: false, minimumVersion: command.floor, support: 'unknown' };
  }
  let version: string | undefined;
  try {
    version = parseVersion(target, await deps.capture([executable, ...command.versionArgs]));
  } catch {
    return { target, detected: true, executable, minimumVersion: command.floor, support: 'unknown' };
  }
  if (version === undefined) {
    return { target, detected: true, executable, minimumVersion: command.floor, support: 'unknown' };
  }
  return {
    target,
    detected: true,
    executable,
    version,
    minimumVersion: command.floor,
    support: Bun.semver.order(version, command.floor) < 0 ? 'unsupported' : 'supported',
  };
}

const requireAbsolute = (value: string, diagnostic: string): string => {
  if (!isAbsolute(value)) throw new Error(diagnostic);
  return value;
};

export async function resolveAgentLocation(
  target: AgentTarget,
  deps: AgentHostDeps,
): Promise<AgentLocation> {
  const command = hostCommand[target];
  const executable = deps.which(command.executable);
  if (executable === null) throw new Error(`${command.executable} is not installed`);

  if (target === 'opencode') {
    const output = await deps.capture([executable, 'debug', 'paths']);
    const config = output.split(/\r?\n/u)
      .map((line) => /^(\S+)\s+(.+)$/u.exec(line.trim()))
      .find((match) => match?.[1] === 'config')?.[2];
    if (config === undefined) throw new Error('opencode debug paths did not report config');
    const hostRoot = join(requireAbsolute(config, 'opencode config path is relative'), 'plugins');
    return {
      target,
      hostRoot,
      managedDir: join(hostRoot, 'aio-proxy'),
      adjacentEntry: join(hostRoot, 'aio-proxy.js'),
    };
  }

  if (target === 'pi') {
    const override = deps.env.PI_CODING_AGENT_DIR;
    const configured = override === undefined || override === ''
      ? join(deps.home, '.pi', 'agent')
      : override === '~'
        ? deps.home
        : override.startsWith('~/')
          ? join(deps.home, override.slice(2))
          : override;
    const agentDir = requireAbsolute(
      configured,
      'Pi agent directory is relative',
    );
    const hostRoot = join(agentDir, 'extensions');
    return { target, hostRoot, managedDir: join(hostRoot, 'aio-proxy') };
  }

  const agentDir = requireAbsolute(
    (await deps.capture([executable, 'config', 'path'])).trim(),
    'omp config path is empty or relative',
  );
  const hostRoot = join(agentDir, 'extensions');
  return { target, hostRoot, managedDir: join(hostRoot, 'aio-proxy') };
}
```

This is the entire `hosts.ts` implementation. It does not infer an OMP profile path in aio-proxy.

- [ ] **Step 5: Implement strict local inspection**

Use `lstat`, never `stat`, for the managed directory, marker, and adjacent entry. Parse marker/state with `AgentManagedMarkerSchema`/`AgentManagedStateV1Schema`; additionally require `marker.agent === location.target`. The OpenCode template is one function used by inspect/install/remove:

```ts
export const openCodeEntry = (installationId: string): string =>
  `// aio-proxy-managed:v1:${installationId}\nexport { default } from "./aio-proxy/index.js";\n`;
```

An absent adjacent entry with a valid OpenCode marker returns `integration: 'managed', entry: 'missing'`; a valid regular entry returns `entry: 'present'`. A present entry whose bytes differ from the template remains `conflict`. Pi/OMP omit `entry`. Status-file parse failure yields catalog `missing` without turning a legally marked directory into user-owned conflict. Freshness is stale when state says stale or `now - lastSuccessfulAt > 600_000`.

- [ ] **Step 6: Run host/inspection tests GREEN**

Run: `bun test packages/cli/src/agent/hosts packages/cli/src/agent/managed-installation/inspect.test.ts`

Expected: PASS; no test scans a project directory or guesses an OMP profile.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/agent/hosts packages/cli/src/agent/managed-installation
git commit -m "feat(cli): inspect agent integrations safely" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Atomic configure/update and validated local removal

**Files:**

- Create: `packages/cli/src/agent/managed-installation/install.ts`
- Test: `packages/cli/src/agent/managed-installation/install.test.ts`
- Create: `packages/cli/src/agent/managed-installation/remove.ts`
- Test: `packages/cli/src/agent/managed-installation/remove.test.ts`
- Create: `packages/cli/src/agent/managed-installation/test-fixture.ts` (test-only, not exported)
- Modify: `packages/cli/src/agent/managed-installation/index.ts`

**Interfaces:**

- Consumes Task 1 assets and Task 2 inspection/location.
- Produces `installManagedIntegration(input, testDeps?): Promise<'installed' | 'updated' | 'newer'>` and `removeManagedIntegration(location, expectedInstallationId, testDeps?): Promise<void>`.

```ts
export type ManagedInstallInput = {
  readonly location: AgentLocation;
  readonly endpoint: string;
  readonly adapterVersion: string;
  readonly requestedInstallationId: string;
  readonly readAssets: () => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly managedOnly?: boolean;
};
export type ManagedInstallTestDeps = {
  readonly failpoint?: (
    point: 'staged' | 'backed_up' | 'directory_swapped' | 'entry_ready',
  ) => void | Promise<void>;
};
export type ManagedRemoveTestDeps = {
  readonly failpoint?: (point: 'content_removed') => void | Promise<void>;
};
```

- [ ] **Step 1: Write failing atomic lifecycle tests**

```ts
// packages/cli/src/agent/managed-installation/test-fixture.ts
import { mock } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AgentCatalogV1, AgentManagedStateV1, AgentTarget } from '@aio-proxy/types';
import type { AgentLocation } from '../hosts';
import type { ManagedInstallInput, ManagedInstallTestDeps } from './install';

export const INSTALL_ID = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
export const fixtureRoots: string[] = [];

export const fixtureCatalog = (agent: AgentTarget): AgentCatalogV1 => ({
  schema_version: 1,
  agent,
  models: [{ id: 'gpt-x', name: 'GPT X', reasoning: false, tool_call: true,
    temperature: false, attachment: false, input: ['text'], context_window: 8_192,
    max_output_tokens: 2_048 }],
});

export const validState = (agent: AgentTarget = 'pi'): AgentManagedStateV1 => ({
  format: 1, catalogSchema: 1, status: 'fresh',
  lastSuccessfulAt: '2026-08-18T00:00:00.000Z', lastError: null,
  lkg: fixtureCatalog(agent),
});

export const openCodeEntry = (installationId: string): string =>
  `// aio-proxy-managed:v1:${installationId}\nexport { default } from "./aio-proxy/index.js";\n`;

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
    target, hostRoot, managedDir,
    ...(target === 'opencode' ? { adjacentEntry: join(hostRoot, 'aio-proxy.js') } : {}),
  };
  await mkdir(hostRoot, { recursive: true });
  if (options.existing === true) {
    await mkdir(managedDir);
    await writeFile(join(managedDir, 'old.js'), 'old-adapter');
    await writeFile(join(managedDir, 'user-edit.txt'), 'replace-me');
    await writeFile(join(managedDir, '.aio-proxy-managed.json'), JSON.stringify({
      format: 1, managedBy: 'aio-proxy', agent: target, installationId: INSTALL_ID,
      adapterVersion: options.adapterVersion ?? '1.0.0', endpoint: 'http://127.0.0.1:9317',
    }));
    if (options.state !== undefined) {
      await writeFile(join(managedDir, '.aio-proxy-state.json'), JSON.stringify(options.state));
    }
    if (location.adjacentEntry !== undefined && options.missingEntry !== true) {
      await writeFile(location.adjacentEntry, openCodeEntry(INSTALL_ID));
    }
  }
  const readAssets = mock(async () => new Map<string, Uint8Array>([
    ['index.js', new TextEncoder().encode(`built-${target === 'opencode' ? 'opencode' : target}`)],
    ['package.json', new TextEncoder().encode('{"type":"module"}\n')],
  ]));
  const input: ManagedInstallInput = {
    location, endpoint: 'http://127.0.0.1:9317', adapterVersion: '2.0.0',
    requestedInstallationId: INSTALL_ID, readAssets,
  };
  const failpointByFailure = {
    'stage write': 'staged',
    'directory swap': 'backed_up',
    'OpenCode entry write': 'directory_swapped',
  } as const;
  const deps: ManagedInstallTestDeps = {
    ...(options.failure === undefined ? {} : {
      failpoint: (point) => {
        if (point === failpointByFailure[options.failure!]) throw new Error(options.failure);
      },
    }),
  };
  return {
    root, location, input, deps, installationId: INSTALL_ID, readAssets,
    beforeTree: await snapshotTree(root),
    tree: () => snapshotTree(root),
  };
}

export async function removeFixture(
  target: AgentTarget,
  options: { readonly conflictingEntry?: boolean } = {},
) {
  const fixture = await installFixture(target, { existing: true });
  if (options.conflictingEntry === true && fixture.location.adjacentEntry !== undefined) {
    await writeFile(fixture.location.adjacentEntry, 'user-owned entry');
  }
  return { ...fixture, beforeTree: await snapshotTree(fixture.root) };
}
```

```ts
// packages/cli/src/agent/managed-installation/install.test.ts and remove.test.ts
import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentManagedMarkerSchema } from '@aio-proxy/types';
import { installManagedIntegration } from './install';
import { removeManagedIntegration } from './remove';
import { fixtureRoots, installFixture, openCodeEntry, removeFixture, validState } from './test-fixture';

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('first configure writes files, marker, and fixed OpenCode entry', async () => {
  const f = await installFixture('opencode');
  await expect(installManagedIntegration(f.input, f.deps)).resolves.toBe('installed');
  expect(await Bun.file(join(f.location.managedDir, 'index.js')).text()).toBe('built-opencode');
  expect(await Bun.file(f.location.adjacentEntry!).text()).toBe(openCodeEntry(f.installationId));
  expect(AgentManagedMarkerSchema.parse(await Bun.file(join(
    f.location.managedDir, '.aio-proxy-managed.json',
  )).json())).toMatchObject({ installationId: f.installationId, endpoint: 'http://127.0.0.1:9317' });
});

test('update preserves only a valid schema-1 state and keeps installation identity', async () => {
  const f = await installFixture('pi', { existing: true, state: validState() });
  await installManagedIntegration({ ...f.input, requestedInstallationId: crypto.randomUUID() }, f.deps);
  expect(await Bun.file(join(f.location.managedDir, '.aio-proxy-state.json')).json()).toEqual(validState());
  await expect(Bun.file(join(f.location.managedDir, '.aio-proxy-managed.json')).json())
    .resolves.toMatchObject({ installationId: f.installationId });
  expect(await Bun.file(join(f.location.managedDir, 'user-edit.txt')).exists()).toBe(false);
});

test('newer adapter exits without reading assets or writing', async () => {
  const f = await installFixture('omp', { existing: true, adapterVersion: '9.0.0' });
  await expect(installManagedIntegration(f.input, f.deps)).resolves.toBe('newer');
  expect(f.readAssets).not.toHaveBeenCalled();
  expect(await f.tree()).toEqual(f.beforeTree);
});

test('newer OpenCode adapter repairs only a missing fixed entry', async () => {
  const f = await installFixture('opencode', {
    existing: true, adapterVersion: '9.0.0', missingEntry: true,
  });
  const oldAdapter = await Bun.file(join(f.location.managedDir, 'old.js')).text();
  await expect(installManagedIntegration(f.input, f.deps)).resolves.toBe('newer');
  expect(f.readAssets).not.toHaveBeenCalled();
  expect(await Bun.file(f.location.adjacentEntry!).text()).toBe(openCodeEntry(f.installationId));
  expect(await Bun.file(join(f.location.managedDir, 'old.js')).text()).toBe(oldAdapter);
});

test('a target replaced while staging is fixed as backup and rejected before promotion', async () => {
  const f = await installFixture('pi', { existing: true });
  const displaced = join(f.root, 'concurrent-original');
  await expect(installManagedIntegration(f.input, {
    failpoint: async (point) => {
      if (point !== 'staged') return;
      await rename(f.location.managedDir, displaced);
      await mkdir(f.location.managedDir);
      await writeFile(join(f.location.managedDir, 'foreign.txt'), 'concurrent replacement');
    },
  })).rejects.toThrow('managed');
  expect(await Bun.file(join(f.location.managedDir, 'foreign.txt')).text()).toBe('concurrent replacement');
  expect(await Bun.file(join(displaced, 'old.js')).text()).toBe('old-adapter');
  expect(await Bun.file(join(f.location.managedDir, 'index.js')).exists()).toBe(false);
});

test.each(['file', 'symlink'] as const)(
  'a concurrently created managed-path %s is preserved', async (kind) => {
    const f = await installFixture('pi');
    const foreign = join(f.root, 'foreign');
    await expect(installManagedIntegration(f.input, {
      failpoint: async (point) => {
        if (point !== 'staged') return;
        if (kind === 'file') await writeFile(f.location.managedDir, 'foreign file');
        else {
          await mkdir(foreign);
          await symlink(foreign, f.location.managedDir, 'dir');
        }
      },
    })).rejects.toThrow();
    if (kind === 'file') expect(await Bun.file(f.location.managedDir).text()).toBe('foreign file');
    else expect((await lstat(f.location.managedDir)).isSymbolicLink()).toBe(true);
  },
);

test.each(['file', 'symlink'] as const)(
  'a concurrently created OpenCode entry %s is never replaced', async (kind) => {
    const f = await installFixture('opencode');
    const foreign = join(f.root, 'foreign-entry.js');
    await writeFile(foreign, 'foreign entry');
    await expect(installManagedIntegration(f.input, {
      failpoint: async (point) => {
        if (point !== 'entry_ready') return;
        if (kind === 'file') await writeFile(f.location.adjacentEntry!, 'foreign entry');
        else await symlink(foreign, f.location.adjacentEntry!, 'file');
      },
    })).rejects.toThrow('entry');
    expect(await Bun.file(f.location.adjacentEntry!).text()).toBe('foreign entry');
    if (kind === 'symlink') expect((await lstat(f.location.adjacentEntry!)).isSymbolicLink()).toBe(true);
  },
);

test.each(['stage write', 'directory swap', 'OpenCode entry write'] as const)(
  '%s failure restores the exact previous tree', async (failure) => {
    const f = await installFixture('opencode', { existing: true, failure });
    await expect(installManagedIntegration(f.input, f.deps)).rejects.toThrow();
    expect(await f.tree()).toEqual(f.beforeTree);
  },
);

test('remove refuses an entry conflict before deleting any byte', async () => {
  const f = await removeFixture('opencode', { conflictingEntry: true });
  await expect(removeManagedIntegration(f.location, f.installationId)).rejects.toThrow('entry');
  expect(await f.tree()).toEqual(f.beforeTree);
});

test('partial deletion keeps the ownership marker and a retry completes', async () => {
  const f = await removeFixture('pi');
  const marker = join(f.location.managedDir, '.aio-proxy-managed.json');
  await expect(removeManagedIntegration(f.location, f.installationId, {
    failpoint: (point) => { if (point === 'content_removed') throw new Error('partial delete'); },
  })).rejects.toThrow('partial delete');
  expect(await Bun.file(marker).exists()).toBe(true);
  await expect(removeManagedIntegration(f.location, f.installationId)).resolves.toBeUndefined();
  expect(await Bun.file(f.location.managedDir).exists()).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test packages/cli/src/agent/managed-installation/install.test.ts packages/cli/src/agent/managed-installation/remove.test.ts`

Expected: FAIL because filesystem mutation functions do not exist.

- [ ] **Step 3: Implement same-parent staged installation**

`installManagedIntegration` first calls `inspectManagedInstallation`. `conflict` throws. When `input.managedOnly === true`, validate `managed` plus the requested installation ID before any newer/repair branch. A newer adapter never loads assets: return `newer` immediately when its entry is present; for OpenCode `entry: 'missing'`, atomically create only `openCodeEntry(marker.installationId)` after one final marker/entry `lstat` check, then return `newer`.

Configure omits `managedOnly`. Post-upgrade sets it to close the inspect→install race and therefore cannot recreate a directory removed after its outer inspection.

1. `mkdir(location.hostRoot, { recursive: true, mode: 0o700 })`.
2. Create a unique staging directory with `mkdtemp(join(location.hostRoot, '.aio-proxy-stage-'))`.
3. Write every fixed relative asset with mode `0o600`, rejecting absolute paths or path segments equal to `..`.
4. Write a new marker with the retained installation ID, current adapter version, and endpoint, mode `0o600`; fsync files and staging directory. Do not read LKG again from the still-mutable target path.
5. If updating, rename whatever currently occupies the fixed managed path to this invocation's unique same-parent backup. Validate that fixed backup from scratch with `lstat` and the strict marker schema, requiring the expected target and installation ID. If it is invalid, restore it and abort. If its adapter is now newer, restore it and return `newer` without promotion.
6. Only after backup validation, parse its `.aio-proxy-state.json`; if schema 1 and target-valid, copy it into staging and fsync the file/directory. Then rename staging to the fixed managed path. Any failure restores the exact backup; remove the backup only after the whole target operation succeeds.
7. For OpenCode, re-`lstat` the adjacent path, durably write the fixed entry to a sibling temporary regular file, then invoke the `entry_ready` failpoint. Commit with `link(temporary, adjacentEntry)`, which atomically fails with `EEXIST` for a concurrent regular file, directory, or symlink; after success unlink the temporary name and fsync the parent. Never use `rename` for this absent-entry creation because it can replace a path created after `lstat`. On first-install entry failure, delete the new directory. On update entry failure, remove the promoted directory and rename the fixed backup back into place. Never follow or replace an entry symlink.

Use `node:fs/promises` plus `FileHandle.sync()` directly. Await the optional four failpoints shown in the interface: `staged` after the asset tree is durable, `backed_up` immediately after the current target is renamed to the unique backup but before backup validation, `directory_swapped` immediately after staging becomes the managed directory, and `entry_ready` after the OpenCode entry temporary file is durable but before its exclusive link. The production call omits them. Every failpoint travels through the same catch/restore path as an I/O exception; cleanup may remove only the exact staging/backup/temporary paths created by this invocation, never a concurrently displaced directory. Directory promotion keeps `rename`: on the supported platforms it cannot replace a non-empty directory, ordinary file, or symlink with the staged directory, and the three race tests preserve those foreign objects; an empty concurrently created directory contains no foreign bytes. Do not add platform-specific `renameat2`/`renamex_np` bindings for that narrower same-user race.

- [ ] **Step 4: Implement validated local deletion**

`removeManagedIntegration` re-inspects immediately before mutation, requires a valid marker whose installation ID equals `expectedInstallationId`, and rejects any conflict. For OpenCode, an absent entry is already a safe terminal state; a present entry must still equal the fixed template. Delete the validated entry first. Then enumerate the fixed managed directory without following symlinks and explicitly remove every child except `.aio-proxy-managed.json`; directories are traversed bottom-up and symlinks are unlinked as entries. Await the `content_removed` test failpoint, delete the marker last, then `rmdir(location.managedDir)`. Never derive a delete target from marker content.

The server revoke happens in Task 4 before this function is called. Any failure before the final marker unlink leaves the marker intact; a failure of the final `rmdir` recreates the exact validated marker bytes/mode before surfacing the error. The already-revoked partial directory therefore remains discoverable, and a repeated remove accepts the missing entry/content. Do not use recursive `rm(location.managedDir)` for the top-level deletion.

- [ ] **Step 5: Run atomic filesystem tests GREEN**

Run: `bun test packages/cli/src/agent/managed-installation`

Expected: PASS; injected failures restore the original installation and no unvalidated path is removed.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/agent/managed-installation
git commit -m "feat(cli): manage agent adapter files atomically" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Agent command orchestration and loopback admin client

**Files:**

- Create: `packages/cli/src/agent/control-plane/index.ts`
- Create: `packages/cli/src/agent/control-plane/control-plane.ts`
- Test: `packages/cli/src/agent/control-plane/control-plane.test.ts`
- Test: `packages/cli/src/control-plane/control-plane.test.ts`
- Create: `packages/cli/src/agent/index.ts`
- Create: `packages/cli/src/agent/agent.ts`
- Test: `packages/cli/src/agent/agent.test.ts`

**Interfaces:**

- Produces `createAgentCommandDeps(cliDeps)`, plus `agentList`, `agentConfigure`, `agentRemove`, and `agentRevoke` whose typed results are rendered by Task 6 Commander actions.
- Consumes Tasks 1–3 plus `resolveControlAddress`, runtime config parsing, and typed admin DTO schemas.

```ts
export type AgentCommandDeps = {
  readonly detectHost: (target: AgentTarget) => Promise<AgentHost>;
  readonly resolveLocation: (target: AgentTarget) => Promise<AgentLocation>;
  readonly inspect: (location: AgentLocation, now: () => number) => Promise<LocalIntegrationStatus>;
  readonly resolveEndpoint: () => Promise<string>;
  readonly install: typeof installManagedIntegration;
  readonly remove: typeof removeManagedIntegration;
  readonly readSnapshot: (endpoint: string) => Promise<AgentAdminSnapshot>;
  readonly revoke: (endpoint: string, installationId: string) => Promise<AgentRevokeStatus>;
  readonly readAssets: (target: AgentTarget) => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly adapterVersion: string;
  readonly randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
  readonly now: () => number;
};
type AgentListTargetBase = {
  readonly target: AgentTarget;
  readonly host: AgentHost;
  readonly authorization: 'not_checked' | AgentInstallationSummary['authorization'] | 'missing';
  readonly schemaCompatibility: 'not_checked' | 'compatible' | 'incompatible';
};
export type AgentListTargetResult = AgentListTargetBase & (
  | {
      readonly integration: 'unresolved';
      readonly reason: 'host_missing' | 'path_unavailable';
    }
  | ({ readonly integration: LocalIntegrationStatus['integration'] }
      & Omit<LocalIntegrationStatus, 'integration'>
      & { readonly endpointMatches?: boolean })
);
export type AgentAuthorizationListItem = AgentInstallationSummary & {
  readonly local: 'configured' | 'orphaned';
};
export type AgentListResult = {
  readonly targets: readonly AgentListTargetResult[];
  readonly server: 'not_checked' | 'reachable' | 'unreachable';
  readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
  readonly catalogSchemaVersions?: readonly number[];
  readonly authorizations?: readonly AgentAuthorizationListItem[];
};
export type AgentConfigureResult = {
  readonly target: AgentTarget;
  readonly host: AgentHost;
  readonly installed: true;
  readonly status: 'installed' | 'updated' | 'newer';
  readonly server: 'reachable' | 'unreachable';
  readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
  readonly loginCommand: 'opencode auth login --provider aio-proxy' | '/login aio-proxy';
  readonly reloadRequired: true;
};
export type AgentRemoveResult = {
  readonly target: AgentTarget;
  readonly installationId: string;
  readonly revokeStatus: AgentRevokeStatus;
};
export type AgentRevokeResult = {
  readonly installationId: string;
  readonly status: AgentRevokeStatus;
};

export declare function agentList(
  options: { readonly check?: boolean; readonly authorizations?: boolean; readonly json?: boolean },
  deps?: AgentCommandDeps,
): Promise<AgentListResult>;
export declare function agentConfigure(target: string, deps?: AgentCommandDeps): Promise<AgentConfigureResult>;
export declare function agentRemove(target: string, deps?: AgentCommandDeps): Promise<AgentRemoveResult>;
export declare function agentRevoke(installationId: string, deps?: AgentCommandDeps): Promise<AgentRevokeResult>;
```

- [ ] **Step 1: Write failing online-client tests**

```ts
const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';

test('snapshot validates capabilities and sends no Agent credential', async () => {
  const calls: Request[] = [];
  const snapshot = await readAgentAdminSnapshot('http://127.0.0.1:9317', async (input, init) => {
    const request = new Request(input, init); calls.push(request);
    return Response.json({ installations: [], deviceAuthorization: 'available', catalogSchemaVersions: [1] });
  });
  expect(snapshot).toEqual({ installations: [], deviceAuthorization: 'available', catalogSchemaVersions: [1] });
  expect(calls[0]!.url).toBe('http://127.0.0.1:9317/admin/agent-installations');
  expect(calls[0]!.headers.get('authorization')).toBeNull();
});

test.each(['revoked', 'expired', 'missing'] as const)('accepts revoke terminal %s', async (status) => {
  await expect(revokeAgentInstallation('http://127.0.0.1:9317', INSTALLATION, async () =>
    Response.json({ installationId: INSTALLATION, status }))).resolves.toBe(status);
});

test.each([404, 500])('rejects revoke HTTP %s without fabricating a terminal status', async (status) => {
  await expect(revokeAgentInstallation('http://127.0.0.1:9317', INSTALLATION, async () =>
    new Response('', { status }))).rejects.toThrow();
});

test.each(['127.example.test', '127.0.0.999', '127.1', '192.0.2.10'])(
  'rejects non-canonical/non-loopback host %s',
  (host) => expect(() => connectHost(host)).toThrow('loopback'),
);

test.each([
  ['0.0.0.0', '127.0.0.1'], ['*', '127.0.0.1'], ['::', '::1'],
  ['localhost', 'localhost'], ['127.255.255.254', '127.255.255.254'], ['::1', '::1'],
] as const)('maps accepted host %s to %s', (host, expected) => {
  expect(connectHost(host)).toBe(expected);
});

test('the shared control address resolves host and port templates from service.env', async () => {
  const previousHost = process.env.AGENT_BIND_HOST;
  const previousPort = process.env.AGENT_BIND_PORT;
  try {
    delete process.env.AGENT_BIND_HOST;
    delete process.env.AGENT_BIND_PORT;
    await withHome((home) => {
      writeFileSync(join(home, 'config.jsonc'), JSON.stringify({
        server: { host: '{{env.AGENT_BIND_HOST}}', port: '{{env.AGENT_BIND_PORT}}' },
        providers: {},
      }));
      writeFileSync(join(home, 'service.env'), 'AGENT_BIND_HOST=127.0.0.9\nAGENT_BIND_PORT=9417\n');
    }, async () => {
      await expect(resolveControlAddress({}))
        .resolves.toEqual({ host: '127.0.0.9', port: '9417' });
    });
  } finally {
    if (previousHost === undefined) delete process.env.AGENT_BIND_HOST;
    else process.env.AGENT_BIND_HOST = previousHost;
    if (previousPort === undefined) delete process.env.AGENT_BIND_PORT;
    else process.env.AGENT_BIND_PORT = previousPort;
  }
});
```

- [ ] **Step 2: Write failing command behavior tests**

```ts
const ORPHAN_INSTALLATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installation = (installationId: string): AgentInstallationSummary => ({
  installationId,
  target: installationId === INSTALLATION ? 'opencode' : 'omp',
  adapterVersion: '1.2.3',
  createdAt: '2026-08-18T00:00:00.000Z',
  lastAuthorizedAt: '2026-08-18T00:00:01.000Z',
  authorization: 'active',
  accessExpiresAt: '2026-08-18T00:15:01.000Z',
});

const commandLocation = (target: AgentTarget): AgentLocation => {
  const hostRoot = `/tmp/${target}/${target === 'opencode' ? 'plugins' : 'extensions'}`;
  return {
    target, hostRoot, managedDir: `${hostRoot}/aio-proxy`,
    ...(target === 'opencode' ? { adjacentEntry: `${hostRoot}/aio-proxy.js` } : {}),
  };
};

function commandFixture(options: {
  readonly server?: 'online' | 'offline';
  readonly serverHost?: string;
  readonly target?: AgentTarget;
  readonly hostSupport?: AgentHost['support'];
  readonly hostVersion?: string;
  readonly missingTargets?: readonly AgentTarget[];
  readonly pathFailureTargets?: readonly AgentTarget[];
  readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
  readonly catalogSchemaVersions?: readonly number[];
  readonly revokeStatus?: AgentRevokeStatus;
  readonly revokeError?: Error;
  readonly localInstallationIds?: readonly string[];
  readonly serverInstallations?: readonly AgentInstallationSummary[];
} = {}) {
  const missing = new Set(options.missingTargets ?? []);
  const pathFailures = new Set(options.pathFailureTargets ?? []);
  const localIds = options.localInstallationIds ??
    (options.target === undefined ? [] : [INSTALLATION]);
  const localByTarget = new Map<AgentTarget, string>();
  if (options.target !== undefined && localIds[0] !== undefined) localByTarget.set(options.target, localIds[0]);
  else (['opencode', 'pi', 'omp'] as const).forEach((target, index) => {
    const installationId = localIds[index];
    if (installationId !== undefined) localByTarget.set(target, installationId);
  });
  const events: string[] = [];
  const install = mock(async () => { events.push('install'); return 'installed' as const; });
  const remove = mock(async () => { events.push('remove'); });
  const revoke = mock(async () => {
    events.push('revoke');
    if (options.revokeError !== undefined) throw options.revokeError;
    return options.revokeStatus ?? 'revoked';
  });
  const deps: AgentCommandDeps = {
    detectHost: async (target) => ({
      target,
      detected: !missing.has(target),
      ...(missing.has(target) ? {} : {
        executable: `/usr/local/bin/${target}`,
        version: options.hostVersion ?? '99.0.0',
      }),
      minimumVersion: { opencode: '1.17.10', pi: '0.84.2', omp: '17.3.7' }[target],
      support: missing.has(target) ? 'unknown' : (options.hostSupport ?? 'supported'),
    }),
    resolveLocation: async (target) => {
      if (pathFailures.has(target)) throw new Error(`${target} path unavailable`);
      return commandLocation(target);
    },
    inspect: async (location) => {
      const installationId = localByTarget.get(location.target);
      if (installationId === undefined) return { integration: 'absent', catalog: 'missing' };
      return {
        integration: 'managed', catalog: 'fresh',
        marker: {
          format: 1, managedBy: 'aio-proxy', agent: location.target,
          installationId, adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
        },
      };
    },
    resolveEndpoint: async () => {
      if (options.serverHost !== undefined && options.serverHost !== '127.0.0.1')
        throw new Error('Agent integrations require loopback');
      return 'http://127.0.0.1:9317';
    },
    install,
    remove,
    readSnapshot: async () => {
      if (options.server === 'offline') throw new TypeError('offline');
      return {
        installations: [...(options.serverInstallations ?? [])],
        deviceAuthorization: options.deviceAuthorization ?? 'available',
        catalogSchemaVersions: [...(options.catalogSchemaVersions ?? [1])],
      };
    },
    revoke,
    readAssets: async () => new Map([['index.js', new TextEncoder().encode('adapter')]]),
    adapterVersion: '1.2.3',
    randomUUID: () => INSTALLATION,
    now: () => Date.parse('2026-08-18T00:05:00.000Z'),
  };
  return { deps, events, install, remove, revoke };
}

test('configure installs while an offline server remains an explicit warning', async () => {
  const f = commandFixture({ server: 'offline', target: 'opencode' });
  await expect(agentConfigure('opencode', f.deps)).resolves.toMatchObject({
    target: 'opencode', installed: true, server: 'unreachable',
    host: { version: '99.0.0', minimumVersion: '1.17.10', support: 'supported' },
    loginCommand: 'opencode auth login --provider aio-proxy',
  });
  expect(f.install).toHaveBeenCalledTimes(1);
});

test('configure returns the host compatibility fields needed for its warning', async () => {
  const f = commandFixture({
    target: 'opencode', hostSupport: 'unsupported', hostVersion: '1.17.9',
  });
  await expect(agentConfigure('opencode', f.deps)).resolves.toMatchObject({
    host: { version: '1.17.9', minimumVersion: '1.17.10', support: 'unsupported' },
  });
});

test('configure rejects explicit non-loopback bind before writing', async () => {
  const f = commandFixture({ serverHost: '192.0.2.10', target: 'pi' });
  await expect(agentConfigure('pi', f.deps)).rejects.toThrow('loopback');
  expect(f.install).not.toHaveBeenCalled();
});

test('password-required capability warns but does not undo installation', async () => {
  const f = commandFixture({ deviceAuthorization: 'password_required', target: 'omp' });
  await expect(agentConfigure('omp', f.deps)).resolves.toMatchObject({
    installed: true, deviceAuthorization: 'password_required', loginCommand: '/login aio-proxy',
  });
});

test.each(['revoked', 'expired', 'missing'] as const)(
  'remove deletes validated files after server terminal %s', async (status) => {
    const f = commandFixture({ revokeStatus: status, target: 'opencode' });
    await agentRemove('opencode', f.deps);
    expect(f.events).toEqual(['revoke', 'remove']);
  },
);

test('remove leaves files untouched on network failure', async () => {
  const f = commandFixture({ revokeError: new TypeError('offline'), target: 'pi' });
  await expect(agentRemove('pi', f.deps)).rejects.toThrow('offline');
  expect(f.remove).not.toHaveBeenCalled();
});

test('authorizations marks configured and orphaned server identities', async () => {
  const f = commandFixture({ localInstallationIds: [INSTALLATION], serverInstallations: [
    installation(INSTALLATION), installation(ORPHAN_INSTALLATION),
  ] });
  const result = await agentList({ authorizations: true }, f.deps);
  expect(result.authorizations).toEqual([
    expect.objectContaining({ installationId: INSTALLATION, local: 'configured' }),
    expect.objectContaining({ installationId: ORPHAN_INSTALLATION, local: 'orphaned' }),
  ]);
});

test('list --check returns the complete per-target and server capability contract', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION],
    serverInstallations: [installation(INSTALLATION)],
    deviceAuthorization: 'password_required',
    catalogSchemaVersions: [1],
  });
  const result = await agentList({ check: true }, f.deps);
  expect(result).toMatchObject({
    server: 'reachable',
    deviceAuthorization: 'password_required',
    catalogSchemaVersions: [1],
  });
  expect(result.targets).toContainEqual(expect.objectContaining({
    target: 'opencode', integration: 'managed',
    endpointMatches: true, authorization: 'active', schemaCompatibility: 'compatible',
    marker: expect.objectContaining({
      installationId: INSTALLATION, adapterVersion: '1.2.3', endpoint: 'http://127.0.0.1:9317',
    }),
  }));
});

test('list --check reports a missing authorization and incompatible catalog schema', async () => {
  const f = commandFixture({
    localInstallationIds: [INSTALLATION], catalogSchemaVersions: [], serverInstallations: [],
  });
  const result = await agentList({ check: true }, f.deps);
  expect(result.targets).toContainEqual(expect.objectContaining({
    target: 'opencode', authorization: 'missing', schemaCompatibility: 'incompatible',
  }));
});

test('local-only list makes authorization and schema checks explicit', async () => {
  const f = commandFixture({ localInstallationIds: [INSTALLATION] });
  const result = await agentList({}, f.deps);
  expect(result.server).toBe('not_checked');
  expect(result.deviceAuthorization).toBeUndefined();
  expect(result.catalogSchemaVersions).toBeUndefined();
  expect(result.targets).toContainEqual(expect.objectContaining({
    target: 'opencode', endpointMatches: true,
    authorization: 'not_checked', schemaCompatibility: 'not_checked',
  }));
});

test('list reports an undetected host as unresolved without resolving its path', async () => {
  const f = commandFixture({ missingTargets: ['opencode'] });
  const result = await agentList({}, f.deps);
  expect(result.targets).toContainEqual(expect.objectContaining({
    target: 'opencode', integration: 'unresolved', reason: 'host_missing',
  }));
});

test('remove fails before revoke when the public host path is unavailable', async () => {
  const f = commandFixture({ target: 'omp', pathFailureTargets: ['omp'] });
  await expect(agentRemove('omp', f.deps)).rejects.toThrow('path unavailable');
  expect(f.revoke).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run tests to verify RED**

Run: `bun test packages/cli/src/agent/control-plane packages/cli/src/agent/agent.test.ts`

Expected: FAIL because online and orchestration functions do not exist.

- [ ] **Step 4: Implement strict loopback endpoint resolution**

Do not reimplement runtime-config reading in the Agent domain. `createAgentCommandDeps().resolveEndpoint` must call the existing `resolveControlAddress({})`, which already executes `configPath()` → `loadServiceEnv(configPath)` → `AtomicConfigFile.read()` → `parseRuntimeConfig()`, then normalize its returned host and build the URL exactly as follows:

```ts
import { isIP } from 'node:net';

export const connectHost = (host: string): string => {
  if (host === '0.0.0.0' || host === '*') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  if (host === 'localhost' || host === '::1') return host;
  if (isIP(host) === 4 && host.split('.')[0] === '127') return host;
  throw new Error('Agent integrations require a loopback aio-proxy endpoint');
};

export const resolveAgentEndpoint = async (): Promise<string> => {
  const { host, port } = await resolveControlAddress({});
  return controlBaseUrl(connectHost(host), port);
};
```

Pass the result to existing `controlBaseUrl`; its existing regression tests prove `controlBaseUrl('::1', '9317') === 'http://[::1]:9317'`, so keep the normalized IPv6 value bare and do not bracket it twice. Marker endpoint never contains a path, query, fragment, username, or password.

- [ ] **Step 5: Implement the typed admin client**

Use `AgentAdminSnapshotSchema` and `AgentRevokeResponseSchema` on every successful JSON response. Fetch has `AbortSignal.timeout(3_000)`, no Authorization header, and no automatic retry. Revoke URL path uses `encodeURIComponent(installationId)` after UUID validation.

- [ ] **Step 6: Implement command semantics**

`agentConfigure` performs: target parse → host detection (missing fails) → location resolution → local inspection → endpoint resolution → generate/reuse installation ID → atomic install → optional health/admin snapshot probe. It returns the complete `AgentHost` so Task 6 can render the exact detected version, minimum version, and unsupported/unknown compatibility warning, plus the native login hint (`opencode auth login --provider aio-proxy` or `/login aio-proxy`) and reload/restart warning. Server unreachable is not an install failure.

`agentList` always evaluates all three local targets. It resolves the configured loopback endpoint once without making a network request and compares it with each valid marker endpoint; if local endpoint parsing fails, `endpointMatches` is absent instead of aborting the other local rows. Without online flags it never calls fetch and returns `authorization: 'not_checked'` plus `schemaCompatibility: 'not_checked'`. `--check` makes one snapshot call, copies `deviceAuthorization` and `catalogSchemaVersions` into the top-level result, maps each valid local marker to a server installation by exact installation ID **and target**, and returns `missing` when no such row exists. Schema 1 is `compatible` exactly when the server snapshot includes `1`; otherwise it is `incompatible`. An unreachable server leaves both checks `not_checked` and omits the two unavailable capability fields. `--authorizations` implies that call and returns every server row with `configured`/`orphaned`; `configured` also requires the exact ID-and-target match. Accept `json` in the options object so Commander does not drop the flag, but keep orchestration format-neutral; Task 6 serializes the returned object or renders localized text.

For each target, `agentList` runs host detection before path resolution. If the executable is missing or its public path command fails, return `integration: 'unresolved'` with a stable `host_missing` or `path_unavailable` reason and continue with the other targets; do not substitute a default path or call `inspectManagedInstallation`. `agentRemove` uses the same gate and fails before revoke when location is unresolved. This keeps “not inspected” distinct from a resolved path whose managed directory is actually absent.

`agentRemove` validates a managed local installation before the network call, invokes revoke with its marker ID, accepts only the three terminal statuses, then calls Task 3 removal. `agentRevoke` validates the UUID, invokes the same client, and never touches host files.

- [ ] **Step 7: Run Agent command tests GREEN**

Run: `bun test packages/cli/src/agent`

Expected: PASS; local list has zero network calls, configure can finish offline, and remove never deletes before a terminal revoke response.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/agent
git commit -m "feat(cli): add agent integration commands" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: New-binary post-upgrade updates

**Files:**

- Create: `packages/cli/src/upgrade/post-upgrade-agents.ts`
- Test: `packages/cli/src/upgrade/post-upgrade-agents.test.ts`
- Create: `packages/cli/src/upgrade/agent-post-upgrade-process.ts`
- Test: `packages/cli/src/upgrade/agent-post-upgrade-process.test.ts`
- Modify: `packages/cli/src/upgrade/upgrade.ts`
- Modify: `packages/cli/src/upgrade/upgrade.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/main.test.ts`

**Interfaces:**

- Produces hidden `aio-proxy __agent-post-upgrade` stdin action and `runAgentPostUpgrade(payload, deps)`.
- Produces `resolveNewAgentBinary(target, installedVersion)` and `invokeAgentPostUpgrade(binary, payload, options?)` at one tested spawn/JSON boundary.
- Extends upgrade dependencies with target capture, the two concrete new-binary process functions, and child invocation.

```ts
export type AgentPostUpgradePayload = {
  readonly format: 1;
  readonly targets: readonly {
    readonly target: AgentTarget;
    readonly managedDir: string;
    readonly adjacentEntry?: string;
  }[];
};
export type AgentPostUpgradeItemResult =
  | { readonly target: AgentTarget; readonly status: 'updated' | 'absent' | 'newer' }
  | { readonly target: AgentTarget; readonly status: 'warning'; readonly reason: string };
export type AgentPostUpgradeDeps = {
  readonly resolveLocation: (target: AgentTarget) => Promise<AgentLocation>;
  readonly inspect: (
    location: AgentLocation,
    now: () => number,
  ) => Promise<LocalIntegrationStatus>;
  readonly install: typeof installManagedIntegration;
  readonly readAssets: (target: AgentTarget) => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly adapterVersion: string;
  readonly now: () => number;
};
export type AgentUpgradeHandoffDeps = {
  readonly captureAgentTargets: () => Promise<AgentPostUpgradePayload>;
  readonly isEffectiveUserRoot: () => boolean;
  readonly resolveNewBinary: (target: UpgradeTarget, installedVersion: string) => Promise<string>;
  readonly invokeAgentPostUpgrade: (
    binary: string,
    payload: AgentPostUpgradePayload,
  ) => Promise<readonly AgentPostUpgradeItemResult[]>;
};
export declare function runAgentPostUpgrade(
  payload: AgentPostUpgradePayload,
  deps: AgentPostUpgradeDeps,
): Promise<readonly AgentPostUpgradeItemResult[]>;
export declare function resolveNewAgentBinary(
  target: UpgradeTarget,
  installedVersion: string,
): Promise<string>;
export declare function invokeAgentPostUpgrade(
  binary: string,
  payload: AgentPostUpgradePayload,
  options?: { readonly timeoutMs?: number },
): Promise<readonly AgentPostUpgradeItemResult[]>;
export declare const AgentPostUpgradePayloadSchema: z.ZodType<AgentPostUpgradePayload>;
export declare const AgentPostUpgradeItemResultsSchema: z.ZodType<readonly AgentPostUpgradeItemResult[]>;
```

Use this complete extended dependency declaration in `upgrade.ts`:

```ts
type UpgradeDeps = AgentUpgradeHandoffDeps & {
  readonly resolveTarget: () => Promise<UpgradeTarget>;
  readonly fetchLatest: (registry: string) => Promise<string>;
  readonly currentVersion: string;
  readonly install: (
    target: UpgradeTarget,
    version: string,
    options: UpgradeOptions,
  ) => Promise<void>;
  readonly isDaemonRunning: () => Promise<boolean>;
  readonly isServiceManaged: () => boolean;
  readonly restartService: () => Promise<void>;
};
```

- [ ] **Step 1: Write failing new-binary ownership tests**

```ts
const POST_UPGRADE_INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const postUpgradeLocation = (target: AgentTarget): AgentLocation => {
  const hostRoot = `/tmp/${target}/${target === 'opencode' ? 'plugins' : 'extensions'}`;
  return {
    target,
    hostRoot,
    managedDir: `${hostRoot}/aio-proxy`,
    ...(target === 'opencode' ? { adjacentEntry: `${hostRoot}/aio-proxy.js` } : {}),
  };
};

const postUpgradeFixture = (options: {
  readonly targets?: readonly AgentTarget[];
  readonly managed?: readonly AgentTarget[];
  readonly failure?: 'path mismatch' | 'marker conflict' | 'entry conflict';
} = {}) => {
  const targets = options.targets ?? ['opencode'];
  const managed = new Set(options.managed ?? targets);
  const payload: AgentPostUpgradePayload = {
    format: 1,
    targets: targets.map((target) => {
      const location = postUpgradeLocation(target);
      return {
        target,
        managedDir: location.managedDir,
        ...(location.adjacentEntry === undefined ? {} : { adjacentEntry: location.adjacentEntry }),
      };
    }),
  };
  const install = mock(async () => 'updated' as const);
  const deps: AgentPostUpgradeDeps = {
    resolveLocation: async (target) => options.failure === 'path mismatch'
      ? { ...postUpgradeLocation(target), managedDir: `/tmp/different/${target}` }
      : postUpgradeLocation(target),
    inspect: async (location) => {
      if (options.failure === 'marker conflict' || options.failure === 'entry conflict') {
        return { integration: 'conflict', catalog: 'missing',
          reason: options.failure === 'entry conflict' ? 'entry_invalid' : 'marker_invalid' };
      }
      if (!managed.has(location.target)) return { integration: 'absent', catalog: 'missing' };
      return {
        integration: 'managed', catalog: 'fresh',
        marker: {
          format: 1, managedBy: 'aio-proxy', agent: location.target,
          installationId: POST_UPGRADE_INSTALLATION, adapterVersion: '1.0.0',
          endpoint: 'http://127.0.0.1:9317',
        },
      };
    },
    install,
    readAssets: async () => new Map([['index.js', new TextEncoder().encode('adapter')]]),
    adapterVersion: '2.0.0',
    now: () => 1_000,
  };
  return { payload, deps, install };
};

test('post-upgrade updates only passed, re-resolved, already-managed targets', async () => {
  const f = postUpgradeFixture({ targets: ['opencode', 'pi'], managed: ['opencode'] });
  const result = await runAgentPostUpgrade(f.payload, f.deps);
  expect(result).toEqual([
    { target: 'opencode', status: 'updated' },
    { target: 'pi', status: 'absent' },
  ]);
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.install.mock.calls[0]![0].adapterVersion).toBe('2.0.0');
});

test.each(['path mismatch', 'marker conflict', 'entry conflict'] as const)(
  '%s warns and writes nothing', async (failure) => {
    const f = postUpgradeFixture({ failure });
    await expect(runAgentPostUpgrade(f.payload, f.deps)).resolves.toEqual([
      expect.objectContaining({ status: 'warning' }),
    ]);
    expect(f.install).not.toHaveBeenCalled();
  },
);

test('post-upgrade never creates an absent integration', async () => {
  const f = postUpgradeFixture({ managed: [] });
  await runAgentPostUpgrade(f.payload, f.deps);
  expect(f.install).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing upgrade handoff tests**

```ts
const PAYLOAD = {
  format: 1,
  targets: [{
    target: 'opencode',
    managedDir: '/tmp/opencode/plugins/aio-proxy',
    adjacentEntry: '/tmp/opencode/plugins/aio-proxy.js',
  }],
} as const satisfies AgentPostUpgradePayload;

// Replace the existing upgrade.test.ts makeDeps helper with the complete extended dependency set.
type UpgradeDeps = NonNullable<Parameters<typeof runUpgradeCommand>[2]>;
const makeDeps = (overrides: Partial<UpgradeDeps> = {}): UpgradeDeps => ({
  resolveTarget: async () => ({ method: 'bun' }),
  fetchLatest: async () => '2.0.0',
  currentVersion: '1.0.0',
  install: async () => {},
  captureAgentTargets: async () => ({ format: 1, targets: [] }),
  isEffectiveUserRoot: () => false,
  resolveNewBinary: async () => '/new/aio-proxy',
  invokeAgentPostUpgrade: async () => [],
  isDaemonRunning: async () => false,
  isServiceManaged: () => true,
  restartService: async () => {},
  ...overrides,
});

test('successful install invokes the newly resolved binary with pre-install targets', async () => {
  const events: string[] = [];
  const deps = makeDeps({
    captureAgentTargets: async () => { events.push('capture'); return PAYLOAD; },
    install: async () => { events.push('install'); },
    resolveNewBinary: async (_target, version) => { events.push(`resolve:${version}`); return '/new/aio-proxy'; },
    invokeAgentPostUpgrade: async (binary, payload) => {
      events.push(`post:${binary}`); expect(payload).toEqual(PAYLOAD); return [];
    },
  });
  await runUpgradeCommand({}, () => {}, deps);
  expect(events).toEqual(['capture', 'install', 'resolve:2.0.0', 'post:/new/aio-proxy']);
});

test('adapter warning does not roll back a successful aio-proxy upgrade', async () => {
  const lines: string[] = [];
  await runUpgradeCommand({}, (line) => lines.push(line), makeDeps({
    invokeAgentPostUpgrade: async () => [{ target: 'omp', status: 'warning', reason: 'entry conflict' }],
  }));
  expect(lines.join('\n')).toContain('aio-proxy agent configure omp');
});

test('a root effective user is warned and still updates only that effective users targets', async () => {
  const lines: string[] = [];
  const post = mock(async () => []);
  await runUpgradeCommand({}, (line) => lines.push(line), makeDeps({
    isEffectiveUserRoot: () => true,
    captureAgentTargets: async () => PAYLOAD,
    invokeAgentPostUpgrade: post,
  }));
  expect(lines.join('\n')).toContain('root');
  expect(lines.join('\n')).toContain('aio-proxy agent configure <target>');
  expect(post).toHaveBeenCalledTimes(1);
});

test('--check never invokes post-upgrade', async () => {
  const post = mock(async () => []);
  await runUpgradeCommand({ check: true }, () => {}, makeDeps({ invokeAgentPostUpgrade: post }));
  expect(post).not.toHaveBeenCalled();
});

test('an up-to-date upgrade never invokes post-upgrade', async () => {
  const post = mock(async () => []);
  await runUpgradeCommand({}, () => {}, makeDeps({
    fetchLatest: async () => '1.0.0',
    currentVersion: '1.0.0',
    invokeAgentPostUpgrade: post,
  }));
  expect(post).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Write failing concrete child-process protocol tests**

```ts
// packages/cli/src/upgrade/agent-post-upgrade-process.test.ts
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { invokeAgentPostUpgrade, resolveNewAgentBinary } from './agent-post-upgrade-process';
import type { AgentPostUpgradePayload } from './post-upgrade-agents';

const PROCESS_PAYLOAD = {
  format: 1,
  targets: [{
    target: 'opencode',
    managedDir: '/tmp/opencode/plugins/aio-proxy',
    adjacentEntry: '/tmp/opencode/plugins/aio-proxy.js',
  }],
} as const satisfies AgentPostUpgradePayload;

const processRoots: string[] = [];
afterEach(async () => {
  await Promise.all(processRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeBinary(
  behavior: 'success' | 'wrong_version' | 'nonzero' | 'malformed' | 'schema_invalid' | 'timeout',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aio-proxy-post-upgrade-child-'));
  processRoots.push(root);
  const binary = join(root, 'aio-proxy');
  const version = behavior === 'wrong_version' ? '1.9.0' : '2.0.0';
  await writeFile(binary, `#!/usr/bin/env bun
if (process.argv[2] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (process.argv[2] !== "__agent-post-upgrade") process.exit(9);
const input = await Bun.stdin.text();
JSON.parse(input);
if (${JSON.stringify(behavior)} === "timeout") await Bun.sleep(60_000);
if (${JSON.stringify(behavior)} === "nonzero") { console.error("child failed"); process.exit(7); }
if (${JSON.stringify(behavior)} === "malformed") console.log("not json");
else if (${JSON.stringify(behavior)} === "schema_invalid") console.log(JSON.stringify([{ target: "unknown", status: "updated" }]));
else console.log(JSON.stringify([{ target: "opencode", status: "updated" }]));
`);
  await chmod(binary, 0o700);
  return binary;
}

test('verified new binary receives one closed-stdin JSON payload and returns typed JSON', async () => {
  const binary = await fakeBinary('success');
  await expect(resolveNewAgentBinary({ method: 'binary', path: binary }, '2.0.0'))
    .resolves.toBe(binary);
  await expect(invokeAgentPostUpgrade(binary, PROCESS_PAYLOAD, { timeoutMs: 1_000 })).resolves.toEqual([
    { target: 'opencode', status: 'updated' },
  ]);
});

test('wrong installed version fails before the hidden command can run', async () => {
  const binary = await fakeBinary('wrong_version');
  await expect(resolveNewAgentBinary({ method: 'binary', path: binary }, '2.0.0'))
    .rejects.toThrow('expected 2.0.0');
});

test('a package-manager upgrade re-resolves aio-proxy from PATH', async () => {
  const binary = await fakeBinary('success');
  const previous = process.env.PATH;
  process.env.PATH = [dirname(binary), previous].filter((value) => value !== undefined).join(delimiter);
  try {
    await expect(resolveNewAgentBinary({ method: 'bun' }, '2.0.0')).resolves.toBe(binary);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test.each(['nonzero', 'malformed', 'schema_invalid'] as const)(
  '%s child output is a protocol failure', async (behavior) => {
    const binary = await fakeBinary(behavior);
    await expect(invokeAgentPostUpgrade(binary, PROCESS_PAYLOAD, { timeoutMs: 1_000 })).rejects.toThrow();
  },
);

test('the hidden child is killed at the configured timeout', async () => {
  const binary = await fakeBinary('timeout');
  await expect(invokeAgentPostUpgrade(binary, PROCESS_PAYLOAD, { timeoutMs: 25 }))
    .rejects.toThrow('timed out');
});
```

- [ ] **Step 4: Run tests to verify RED**

Run: `bun test packages/cli/src/upgrade/post-upgrade-agents.test.ts packages/cli/src/upgrade/agent-post-upgrade-process.test.ts packages/cli/src/upgrade/upgrade.test.ts`

Expected: FAIL because upgrade has no adapter handoff.

- [ ] **Step 5: Implement the hidden stdin action**

Commander registers `program.command('__agent-post-upgrade', { hidden: true })`; `hideHelp()` belongs to `Option`, not `Command`, in Commander 15. The action reads at most 64 KiB from stdin, parses a strict Zod schema, and calls `runAgentPostUpgrade` with the current binary's `VERSION` and `deps.agentAssetPaths()`. It prints one JSON result array to stdout and no secret.

Define and export the two schemas consumed by the hidden action and parent process. Unknown fields, duplicate targets, non-absolute paths, a non-OpenCode `adjacentEntry`, or an OpenCode row without one are rejected before any filesystem read:

```ts
import { isAbsolute } from 'node:path';
import { AgentTargetSchema, type AgentTarget } from '@aio-proxy/types';
import { z } from 'zod';

const PostUpgradeTargetSchema = z.strictObject({
  target: AgentTargetSchema,
  managedDir: z.string().refine(isAbsolute, 'managedDir must be absolute'),
  adjacentEntry: z.string().refine(isAbsolute, 'adjacentEntry must be absolute').optional(),
}).superRefine((row, context) => {
  if ((row.target === 'opencode') !== (row.adjacentEntry !== undefined)) {
    context.addIssue({ code: 'custom', message: 'adjacentEntry is required only for OpenCode' });
  }
});

export const AgentPostUpgradePayloadSchema: z.ZodType<AgentPostUpgradePayload> = z.strictObject({
  format: z.literal(1),
  targets: z.array(PostUpgradeTargetSchema).max(3),
}).superRefine((payload, context) => {
  const seen = new Set<AgentTarget>();
  payload.targets.forEach((row, index) => {
    if (seen.has(row.target)) {
      context.addIssue({ code: 'custom', path: ['targets', index, 'target'], message: 'duplicate target' });
    }
    seen.add(row.target);
  });
});

const PostUpgradeItemResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ target: AgentTargetSchema, status: z.literal('updated') }),
  z.strictObject({ target: AgentTargetSchema, status: z.literal('absent') }),
  z.strictObject({ target: AgentTargetSchema, status: z.literal('newer') }),
  z.strictObject({
    target: AgentTargetSchema,
    status: z.literal('warning'),
    reason: z.string().trim().min(1),
  }),
]);

export const AgentPostUpgradeItemResultsSchema: z.ZodType<readonly AgentPostUpgradeItemResult[]> =
  z.array(PostUpgradeItemResultSchema).max(3);
```

Bound stdin while reading, not after an unbounded `Bun.stdin.text()` allocation:

```ts
const POST_UPGRADE_STDIN_LIMIT = 64 * 1_024;

async function readAgentPostUpgradePayload(): Promise<AgentPostUpgradePayload> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > POST_UPGRADE_STDIN_LIMIT) {
        await reader.cancel();
        throw new Error('Agent post-upgrade payload exceeds 64 KiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Agent post-upgrade payload is malformed JSON');
  }
  return AgentPostUpgradePayloadSchema.parse(decoded);
}
```

For every payload row, re-run `resolveAgentLocation(target)` and require its managed/adjacent paths to equal the payload byte-for-byte after `resolve()`. Inspect local state. `absent` is skipped; `conflict` is a warning; only `managed` calls Task 3 install with `managedOnly: true`, retained installation ID, marker endpoint, and current embedded assets. Catch per-target failures and continue.

Reject duplicate targets, unknown fields, relative paths, and more than three rows. Do not look at `SUDO_USER`; process home/effective identity is authoritative.

- [ ] **Step 6: Invoke the installed binary, never the current process**

Before installation, `runUpgradeCommand` captures only currently resolvable target paths. Once it has established that an actual upgrade will run, it checks `deps.isEffectiveUserRoot()`; when true it prints the localized `cli.agent.upgrade.root_effective_user` warning and continues with that effective user's paths. The production dependency is exactly `() => process.getuid?.() === 0`: do not add a package, inspect `SUDO_USER`, guess another home, or claim Windows Administrator detection in the currently published platform matrix. Rename the child-process dependency `invokeAgentPostUpgrade(binary, payload)`; `runAgentPostUpgrade(payload, deps)` remains only the in-process hidden-command implementation. Let `installedVersion` be the exact `latest` value already passed to `deps.install(target, latest, options)`. After that install:

1. Resolve `aio-proxy` again from PATH (for a direct binary replacement, the known target path is also accepted).
2. Spawn `[newBinary, '--version']`, parse its trimmed output as semver, and require equality with `installedVersion`; do not perform a second registry lookup.
3. Spawn `[newBinary, '__agent-post-upgrade']` with payload JSON on stdin, `stdout: 'pipe'`, `stderr: 'pipe'`, and a 30-second timeout.
4. Parse its JSON result. Spawn/protocol failure becomes one localized aggregate warning; item warnings are printed with `aio-proxy agent configure <target>` repair commands.
5. Continue the existing managed-daemon restart logic after post-upgrade finishes.

Do not call Task 3 install directly from the old process. The new child owns `agentAssetPaths()` and `VERSION`.

Implement the process boundary in `agent-post-upgrade-process.ts` with the installed `UpgradeTarget` contract; package-manager upgrades resolve the post-install executable with `Bun.which('aio-proxy')`, while direct-binary upgrades reuse only `target.path`:

```ts
import type { UpgradeTarget } from './constants';
import {
  AgentPostUpgradeItemResultsSchema,
  type AgentPostUpgradeItemResult,
  type AgentPostUpgradePayload,
} from './post-upgrade-agents';

const CHILD_TIMEOUT_MS = 30_000;

type PipedChild = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number | NodeJS.Signals) => void;
};

async function collectChild(
  child: PipedChild,
  timeoutMs: number,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`aio-proxy child timed out after ${timeoutMs}ms`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveNewAgentBinary(
  target: UpgradeTarget,
  installedVersion: string,
): Promise<string> {
  const binary = target.method === 'binary' ? target.path : Bun.which('aio-proxy');
  if (binary === null) throw new Error('upgraded aio-proxy is not on PATH');
  const checked = await collectChild(Bun.spawn([binary, '--version'], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  }), CHILD_TIMEOUT_MS);
  if (checked.exitCode !== 0) {
    throw new Error(`upgraded aio-proxy --version exited ${checked.exitCode}: ${checked.stderr.trim()}`);
  }
  const actualVersion = checked.stdout.trim();
  try {
    Bun.semver.order(actualVersion, installedVersion);
  } catch {
    throw new Error(`upgraded aio-proxy returned invalid version: ${actualVersion}`);
  }
  if (actualVersion !== installedVersion) {
    throw new Error(`upgraded aio-proxy version mismatch: expected ${installedVersion}, got ${actualVersion}`);
  }
  return binary;
}

export async function invokeAgentPostUpgrade(
  binary: string,
  payload: AgentPostUpgradePayload,
  options: { readonly timeoutMs?: number } = {},
): Promise<readonly AgentPostUpgradeItemResult[]> {
  const child = Bun.spawn([binary, '__agent-post-upgrade'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch (error) {
    try { child.kill('SIGKILL'); } catch {}
    throw error;
  }
  const result = await collectChild(child, options.timeoutMs ?? CHILD_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error(`aio-proxy __agent-post-upgrade exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    throw new Error('aio-proxy __agent-post-upgrade returned malformed JSON');
  }
  return AgentPostUpgradeItemResultsSchema.parse(decoded);
}
```

The parent writes exactly one JSON value and calls `.end()` before awaiting output. Both subprocesses pipe and fully drain stdout/stderr. Spawn errors, timeout, non-zero exit, malformed JSON, and schema-invalid JSON all become the existing aggregate upgrade warning; none roll back the completed aio-proxy installation.

- [ ] **Step 7: Run upgrade tests GREEN**

Run: `bun test packages/cli/src/upgrade packages/cli/src/main.test.ts`

Expected: PASS; event order proves the new binary runs after installation, and adapter failures do not change upgrade success.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/upgrade packages/cli/src/main.ts packages/cli/src/main.test.ts
git commit -m "feat(cli): update managed agents after upgrade" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Public CLI registration, localized UX, docs, and release gate

**Files:**

- Create: `packages/cli/src/agent/output.ts`
- Test: `packages/cli/src/agent/output.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/main.test.ts`
- Modify: `packages/cli/src/completion/scripts.ts`
- Modify: `packages/cli/src/completion/completion.test.ts`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `README.md`
- Modify: `.changeset/config.json`
- Create: `.changeset/*.md` using the exact filename emitted by `bun changeset`

**Interfaces:**

- Consumes Tasks 1–5 and all preceding control-plane/adapter plans.
- Produces `renderAgentList(result, json)`, `renderAgentConfigure(result)`, `renderAgentRemove(result)`, `renderAgentRevoke(result)`, `registerAgentCommands(program, { actions, print })`, the user-visible commands/help/completion/copy, documentation, Changeset, and release-ready verification evidence.

- [ ] **Step 1: Write failing renderer and Commander stdout tests**

```ts
// packages/cli/src/agent/output.test.ts
const OUTPUT_INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const completeListResult: AgentListResult = {
  targets: [{
    target: 'opencode',
    host: {
      target: 'opencode', detected: true, version: '1.17.10',
      minimumVersion: '1.17.10', support: 'supported',
    },
    integration: 'managed',
    marker: {
      format: 1, managedBy: 'aio-proxy', agent: 'opencode',
      installationId: OUTPUT_INSTALLATION, adapterVersion: '1.2.3',
      endpoint: 'http://127.0.0.1:9317',
    },
    entry: 'present', catalog: 'fresh',
    lastSuccessfulAt: '2026-08-18T00:05:00.000Z', endpointMatches: true,
    authorization: 'active', schemaCompatibility: 'compatible',
  }],
  server: 'reachable',
  deviceAuthorization: 'available',
  catalogSchemaVersions: [1],
  authorizations: [{
    installationId: OUTPUT_INSTALLATION, target: 'opencode', adapterVersion: '1.2.3',
    createdAt: '2026-08-18T00:00:00.000Z',
    lastAuthorizedAt: '2026-08-18T00:00:01.000Z',
    authorization: 'active', accessExpiresAt: '2026-08-18T00:15:01.000Z',
    local: 'configured',
  }],
};

test('JSON list rendering is exactly one parseable line', () => {
  const lines = renderAgentList(completeListResult, true);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual(completeListResult);
});

test('text list rendering exposes every diagnostic field promised by list --check', () => {
  const text = renderAgentList(completeListResult, false).join('\n');
  for (const value of [
    '1.17.10', OUTPUT_INSTALLATION, '1.2.3', 'http://127.0.0.1:9317',
    'match', '2026-08-18T00:05:00.000Z', 'active', 'compatible', 'available', '1',
  ]) expect(text).toContain(value);
});

test.each([
  [{ version: '1.17.9', minimumVersion: '1.17.10', support: 'unsupported' }, '1.17.9', '1.17.10'],
  [{ minimumVersion: '1.17.10', support: 'unknown' }, 'opencode', 'version'],
] as const)('configure renders host compatibility warning for %o', (hostFields, first, second) => {
  const lines = renderAgentConfigure({
    target: 'opencode', installed: true, status: 'installed', server: 'reachable',
    host: { target: 'opencode', detected: true, ...hostFields },
    deviceAuthorization: 'available',
    loginCommand: 'opencode auth login --provider aio-proxy', reloadRequired: true,
  });
  expect(lines.join('\n')).toContain(first);
  expect(lines.join('\n')).toContain(second);
});
```

Append this real Commander binding test to `main.test.ts`; it verifies stdout rather than only action return values:

```ts
const listResult: AgentListResult = {
  targets: [{
    target: 'opencode',
    host: {
      target: 'opencode', detected: true, support: 'supported',
      version: '1.17.10', minimumVersion: '1.17.10',
    },
    integration: 'absent', catalog: 'missing',
    authorization: 'not_checked', schemaCompatibility: 'not_checked',
  }],
  server: 'not_checked',
};
const configureResult: AgentConfigureResult = {
  target: 'opencode', installed: true, status: 'installed', server: 'unreachable',
  host: {
    target: 'opencode', detected: true, support: 'supported',
    version: '1.17.10', minimumVersion: '1.17.10',
  },
  loginCommand: 'opencode auth login --provider aio-proxy', reloadRequired: true,
};
const removeResult: AgentRemoveResult = {
  target: 'opencode', installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09', revokeStatus: 'revoked',
};
const revokeResult: AgentRevokeResult = {
  installationId: removeResult.installationId, status: 'revoked',
};

function agentProgram() {
  const lines: string[] = [];
  const actions: AgentCliActions = {
    list: mock(async () => listResult),
    configure: mock(async () => configureResult),
    remove: mock(async () => removeResult),
    revoke: mock(async () => revokeResult),
  };
  const program = new Command().name('aio-proxy').exitOverride();
  registerAgentCommands(program, { actions, print: (line) => lines.push(line) });
  return { actions, lines, program };
}

test.each([
  [['agent', 'list'], 'list'],
  [['agent', 'configure', 'opencode'], 'configure'],
  [['agent', 'remove', 'opencode'], 'remove'],
  [['agent', 'revoke', removeResult.installationId], 'revoke'],
] as const)('%s awaits its action and prints text', async (args, action) => {
  const f = agentProgram();
  await f.program.parseAsync(['node', 'aio-proxy', ...args]);
  expect(f.actions[action]).toHaveBeenCalledTimes(1);
  expect(f.lines.length).toBeGreaterThan(0);
});

test('agent list --json forwards json in options and prints one JSON result', async () => {
  const f = agentProgram();
  await f.program.parseAsync(['node', 'aio-proxy', 'agent', 'list', '--check', '--json']);
  expect(f.actions.list).toHaveBeenCalledWith({ check: true, authorizations: false, json: true });
  expect(f.lines).toHaveLength(1);
  expect(JSON.parse(f.lines[0]!)).toEqual(listResult);
});

test('the real buildProgram registers public Agent commands and keeps the child action hidden', () => {
  const program = buildProgram();
  const agent = program.commands.find((command) => command.name() === 'agent');
  const child = program.commands.find((command) => command.name() === '__agent-post-upgrade');
  expect(agent?.commands.map((command) => command.name())).toEqual([
    'list', 'configure', 'remove', 'revoke',
  ]);
  expect(child).toBeDefined();
  const help = program.helpInformation();
  expect(help).toContain('agent');
  expect(help).not.toContain('__agent-post-upgrade');
});
```

Keep this `buildProgram()` assertion in addition to the injected `registerAgentCommands` stdout tests. It is the registration gate for both the public `agent` tree and the hidden new-binary protocol; a helper-only Commander test cannot replace it.

- [ ] **Step 2: Implement renderers and register the exact public commands**

`output.ts` is formatting-only and never reads credentials or the filesystem:

```ts
export function renderAgentList(result: AgentListResult, json: boolean): string[] {
  if (json) return [JSON.stringify(result)];
  const lines = result.targets.map((target) => target.integration === 'unresolved'
    ? m['cli.agent.list.unresolved']({
        target: target.target, reason: target.reason,
        hostVersion: target.host.version ?? 'unknown', minimumVersion: target.host.minimumVersion,
        support: target.host.support, authorization: target.authorization,
        schemaCompatibility: target.schemaCompatibility,
      })
    : m['cli.agent.list.target']({
        target: target.target,
        hostVersion: target.host.version ?? 'unknown', minimumVersion: target.host.minimumVersion,
        support: target.host.support, integration: target.integration,
        installationId: target.marker?.installationId ?? '-',
        adapterVersion: target.marker?.adapterVersion ?? '-',
        endpoint: target.marker?.endpoint ?? '-',
        endpointMatch: target.endpointMatches === undefined
          ? 'unknown'
          : (target.endpointMatches ? 'match' : 'mismatch'),
        catalog: target.catalog, lastSuccessfulAt: target.lastSuccessfulAt ?? '-',
        authorization: target.authorization, schemaCompatibility: target.schemaCompatibility,
      }));
  if (result.server !== 'not_checked') {
    lines.push(m['cli.agent.list.server']({ status: result.server }));
  }
  if (result.deviceAuthorization !== undefined && result.catalogSchemaVersions !== undefined) {
    lines.push(m['cli.agent.list.capabilities']({
      deviceAuthorization: result.deviceAuthorization,
      catalogSchemaVersions: result.catalogSchemaVersions.length === 0
        ? 'none'
        : result.catalogSchemaVersions.join(','),
    }));
  }
  for (const authorization of result.authorizations ?? []) {
    lines.push(m['cli.agent.list.authorization']({
      installationId: authorization.installationId,
      target: authorization.target,
      authorization: authorization.authorization,
      local: authorization.local,
    }));
  }
  return lines;
}

export function renderAgentConfigure(result: AgentConfigureResult): string[] {
  const lines = [result.status === 'newer'
    ? m['cli.agent.configure.newer']({ target: result.target })
    : m['cli.agent.configure.result']({ target: result.target, status: result.status })];
  if (result.host.support === 'unsupported') {
    lines.push(m['cli.agent.configure.unsupported']({
      target: result.target, version: result.host.version ?? 'unknown',
      minimum: result.host.minimumVersion,
    }));
  } else if (result.host.support === 'unknown') {
    lines.push(m['cli.agent.configure.version_unknown']({ target: result.target }));
  }
  if (result.server === 'unreachable') lines.push(m['cli.agent.configure.server_offline']());
  if (result.deviceAuthorization === 'password_required')
    lines.push(m['cli.agent.configure.password_required']());
  lines.push(m['cli.agent.configure.login']({ command: result.loginCommand }));
  lines.push(m['cli.agent.configure.reload']({ target: result.target }));
  return lines;
}

export const renderAgentRemove = (result: AgentRemoveResult): string[] => [
  m['cli.agent.remove.success']({ target: result.target, installationId: result.installationId }),
];
export const renderAgentRevoke = (result: AgentRevokeResult): string[] => [
  m['cli.agent.revoke.success']({ installationId: result.installationId, status: result.status }),
];
```

Register actions through one narrow injected surface so tests capture stdout without replacing `console.log` globally:

```ts
export type AgentCliActions = {
  readonly list: (options: { readonly check: boolean; readonly authorizations: boolean; readonly json: boolean })
    => Promise<AgentListResult>;
  readonly configure: (target: string) => Promise<AgentConfigureResult>;
  readonly remove: (target: string) => Promise<AgentRemoveResult>;
  readonly revoke: (installationId: string) => Promise<AgentRevokeResult>;
};

export function registerAgentCommands(
  program: Command,
  input: { readonly actions: AgentCliActions; readonly print: (line: string) => void },
): void {
  const emit = (lines: readonly string[]): void => { for (const line of lines) input.print(line); };
  const agent = program.command('agent').description(m['cli.agent.description']());
  agent.command('list')
    .option('--check', m['cli.agent.list.option_check']())
    .option('--authorizations', m['cli.agent.list.option_authorizations']())
    .option('--json')
    .action(async (options) => {
      const normalized = {
        check: options.check === true,
        authorizations: options.authorizations === true,
        json: options.json === true,
      };
      emit(renderAgentList(await input.actions.list(normalized), normalized.json));
    });
  agent.command('configure <target>').action(async (target) => {
    emit(renderAgentConfigure(await input.actions.configure(target)));
  });
  agent.command('remove <target>').action(async (target) => {
    emit(renderAgentRemove(await input.actions.remove(target)));
  });
  agent.command('revoke <installation-id>').action(async (installationId) => {
    emit(renderAgentRevoke(await input.actions.revoke(installationId)));
  });
}
```

In `buildProgram`, create one `commandDeps = createAgentCommandDeps(deps)` and call `registerAgentCommands` with four closures over the Task 4 functions and `print: console.log`. Every action explicitly awaits, renders, and prints; returning a result object from an action is never treated as stdout.

Command functions parse targets/UUIDs and throw the existing typed `CliExit` categories; Commander must not accept an omitted configure/remove target. Add `agent` to the existing static top-level completion list for bash, zsh, and fish. Do not expand the completion subsystem or add another shell/dependency in this feature.

- [ ] **Step 3: Add complete five-locale lifecycle copy**

Add localized keys for: Agent command descriptions; list/check/authorizations options; `list.unresolved`, `list.target`, `list.server`, `list.capabilities`, `list.authorization`; host missing; unsupported/unknown version; unresolved/managed/absent/conflict; fresh/stale/missing; authorization and schema compatibility states; endpoint match/mismatch/unknown; `configure.result`; offline server; password required; `configure.login`; installed/updated/newer; reload hint; revoke/remove success; non-loopback rejection; ownership conflict; post-upgrade item warning; and root-user effective-home warning.

Use these exact core messages as the semantic source (translate naturally in all four non-English files):

| Key suffix after `cli.agent.` | English semantic source |
| --- | --- |
| `description` | Manage Agent integrations |
| `list.unresolved` | {target}: unresolved ({reason}); host {hostVersion} (minimum {minimumVersion}, {support}); authorization {authorization}; schema {schemaCompatibility} |
| `list.target` | {target}: host {hostVersion} (minimum {minimumVersion}, {support}); integration {integration}; installation {installationId}; adapter {adapterVersion}; endpoint {endpoint} ({endpointMatch}); catalog {catalog} (last success {lastSuccessfulAt}); authorization {authorization}; schema {schemaCompatibility} |
| `list.server` | aio-proxy: {status} |
| `list.capabilities` | Device authorization {deviceAuthorization}; catalog schemas {catalogSchemaVersions} |
| `list.authorization` | {installationId}: {target}, {authorization}, {local} |
| `configure.host_missing` | {target} is not installed; aio-proxy did not change any files. |
| `configure.unsupported` | {target} {version} is below the supported minimum {minimum}; installed with a compatibility warning. |
| `configure.version_unknown` | Could not determine the {target} version; installed with a compatibility warning. |
| `configure.result` | {target}: {status}. |
| `configure.server_offline` | The integration is installed, but aio-proxy is not running. Start it before signing in. |
| `configure.password_required` | Set server.password before Agent authorization can be approved while server.apiKeys is enabled. |
| `configure.login` | Sign in with: {command} |
| `configure.reload` | Reload or restart {target} to load the updated integration. |
| `configure.newer` | {target} already has a newer adapter; it was not downgraded. |
| `conflict` | Refusing to manage {path}: it is not an intact aio-proxy-managed integration. |
| `remove.server_required` | Start the local aio-proxy control plane and retry; no files were removed. |
| `remove.success` | Revoked installation {installationId} and removed the {target} integration. |
| `revoke.success` | Installation {installationId}: {status}. |
| `upgrade.warning` | aio-proxy upgraded, but {target} could not be updated: {reason}. Repair with: aio-proxy agent configure {target} |
| `upgrade.root_effective_user` | aio-proxy upgrade is running as root; only root's Agent integrations will be updated. Run aio-proxy agent configure <target> again as each regular user that owns integrations. |

Tests assert every new key exists in all five source locale files and compiled Paraglide output; do not fall back to English strings in code.

- [ ] **Step 4: Document product behavior**

Add a concise README section containing:

```text
aio-proxy agent configure opencode
aio-proxy agent configure pi
aio-proxy agent configure omp
aio-proxy agent list --check
aio-proxy agent list --authorizations
aio-proxy agent remove <target>
```

State the floors, native login commands, global-only scope, Device Approval/password rule, remove-vs-host-logout distinction, offline remove behavior, and reload requirement after configure/upgrade. Explicitly state that no upstream API key or shared embedded SK is copied into an Agent.

- [ ] **Step 5: Update the lockstep release set and author one Changeset**

Add these private packages to `.changeset/config.json`'s existing fixed array:

```text
"@aio-proxy/agent-provider-runtime",
"@aio-proxy/opencode-provider",
"@aio-proxy/pi-provider"
```

Run `bun changeset` and select a `minor` bump for `aio-proxy` and every actually modified package at the same level, including at minimum `@aio-proxy/cli`, `@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/types`, `@aio-proxy/dashboard`, `@aio-proxy/i18n`, and the three new private packages. The note names all three targets, their floors/login commands, managed upgrade behavior, and the requirement to reload the Agent. Do not target only internal packages and do not run `changeset version` or publish.

- [ ] **Step 6: Run focused CLI and distribution verification**

Run:

```bash
bun run i18n:compile
bun run --filter @aio-proxy/opencode-provider build
bun run --filter @aio-proxy/pi-provider build
bun run --filter @aio-proxy/opencode-provider test:artifact
bun run --filter @aio-proxy/pi-provider test:artifact
bun test packages/cli/src/agent packages/cli/src/upgrade packages/cli/src/completion packages/cli/src/main.test.ts
bun run --filter @aio-proxy/cli build:binary darwin-arm64
```

Expected: PASS; command help/completion includes Agent commands, compiled binary tests use embedded provider bytes, and no host auth/config file is touched.

- [ ] **Step 7: Run adapter compatibility and full preflight**

Run:

```bash
bun run --filter @aio-proxy/opencode-provider test:compat
bun run --filter @aio-proxy/pi-provider test:compat
bun run preflight
git diff --check
git status --short
```

Expected: both root-level artifact guards, all pinned host matrices, and repository checks pass; status contains only files named by the spec/four plans plus generated migration/i18n/route/Changeset artifacts.

- [ ] **Step 8: Commit release metadata and documentation**

```bash
git add packages/cli packages/i18n README.md .changeset/config.json .changeset/*.md
git commit -m "feat: ship managed Agent integrations" -m "Co-authored-by: Codex <noreply@openai.com>"
```
