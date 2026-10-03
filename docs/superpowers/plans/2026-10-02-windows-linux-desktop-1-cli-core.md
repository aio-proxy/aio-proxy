# Windows and Linux Desktop — Phase 1: CLI and Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows `aio-proxy` CLI with a per-user Task Scheduler service, make the desktop token and `__desktop-connect` work on Linux and Windows, and make a user's stop/uninstall persist on Linux and Windows.

**Architecture:** `packages/cli/src/service/` splits into one backend per service manager (`launchd.ts`, `systemd.ts`, `schtasks.ts`) behind the existing `service.ts` entry points. `__desktop-connect` keeps its `protocolVersion: 1` output and gains per-platform probes (`systemd-inspect.ts`, `schtasks-inspect.ts`) plus per-platform socket listings. A hidden `__service-run` subcommand supervises the proxy under Task Scheduler.

**Tech Stack:** Bun (`bun test`, `Bun.spawn`, `bun:ffi` for the Job Object), TypeScript, `es-toolkit`, `schtasks`, `systemctl --user`, `netstat`/`tasklist`, `/proc/net/tcp{,6}`.

**Spec:** `docs/superpowers/specs/2026-10-02-windows-linux-desktop-design.md` (rev 4), sections 2a–2d. Read phase 0's `2026-10-02-windows-linux-desktop-spike-findings.md` first: its chosen task action and logon type override the defaults below.

## Global Constraints

- npm package `@aio-proxy/cli-win32-x64`, `os: ["win32"]`, `cpu: ["x64"]`, binary `bin/aio-proxy.exe`, compile target `bun-windows-x64`.
- Task path `\AIO Proxy\aio-proxy-<current user SID>`; task XML and `service.json` are always written together.
- Spec file `%LOCALAPPDATA%\aio-proxy\service.json` = `{ exec, env }`; state file `%LOCALAPPDATA%\aio-proxy\service.state.json` = `{ pid }`.
- `__service-run` exit decisions: 0 or 1 → stop; 75 → re-read spec, relaunch at once; other → relaunch after 5 s; `exec` missing → exit 0.
- `RestartOnFailure`: interval `PT1M`, count `3`.
- Uninstall marker (per user, fixed path): Linux `<systemd user unit dir>/aio-proxy.service.uninstalled`; Windows `%LOCALAPPDATA%\aio-proxy\service.uninstalled`.
- In-service restart on win32: rewrite spec (and XML if `exec` changed), return normally, `process.exit(75)` after 1 s.
- Task Scheduler queries capture output and pass `/HRESULT`; not-found = `0x80070002`.
- New modules follow CLAUDE.md layout: `foo/index.ts` (exports only), `foo/foo.ts`, `foo/foo.test.ts`.
- Clean runners run `bun install --frozen-lockfile` then `bun run build` before tests or `build-binary.ts`.
- Windows token path: `%LOCALAPPDATA%\aio-proxy\desktop-tokens\<sha256 hex of the resolved home>`.
- Stable-copy directory segment recognized as desktop-managed: `aio-proxy-desktop/bin/` (any separator; case-insensitive on win32).
- `__desktop-connect` output stays `protocolVersion: 1`; field meanings unchanged.
- Every CLI child process on win32 uses `windowsHide: true`.
- Files over 400 lines are split before growing (CLAUDE.md); `service.ts` is 403 lines today.
- Tests colocated (`foo/foo.test.ts`); run with `cd packages/cli && bun run test:unit` / `cd packages/core && bun test`.

## Review Focus

- A Windows profile path with spaces and non-ASCII characters (`C:\Users\Zoë Chen\…`) as `exec`, home and spec path — owned by Task 7 (XML/spec round trip) and Task 4 (token path).
- The same home spelled differently on Windows (`C:\Users\a\.aio-proxy` vs `c:\users\a\.aio-proxy\`) must hash to one token — owned by Task 4.
- A proxy listening only on `::1` or on a dual-stack wildcard — owned by Tasks 5–6 (IPv6 rows, `*:port`).
- A user stops the service, then the desktop app restarts: discovery must report `disabled: true` — owned by Tasks 9–10 and 12.
- First run on a machine with no unit and no marker must still auto-install (`disabled: false`) — owned by Task 12.

---

### Task 1: Split `service.ts` by service manager

Pure move; behavior and existing tests unchanged.

**Files:**
- Create: `packages/cli/src/service/launchd.ts`, `packages/cli/src/service/systemd.ts`
- Modify: `packages/cli/src/service/service.ts`, `packages/cli/src/service/index.ts`

**Interfaces:**
- Produces: `launchd.ts` exports `launchdPlistPath`, `launchdDomain`, `launchdJobTarget`, `printLaunchdJob`, `startLaunchdJob`, `bootoutLaunchdJob`, `spawnDarwinRestartHelper`, `isDarwinLaunchdJob`; `systemd.ts` exports `systemdUnitPath`. `service.ts` keeps every currently exported name (re-exporting where moved).

- [ ] **Step 1:** Move the launchd helpers (`service.ts` lines 54–112, 321–335) into `launchd.ts` and `systemdUnitPath` into `systemd.ts`; import them back into `service.ts`.
- [ ] **Step 2: Run** `cd packages/cli && bun run test:unit src/service src/desktop-connect src/upgrade` — Expected: all PASS, no test edited.
- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/service
git commit -m "refactor(cli): split service backends by manager"
```

### Task 2: Windows binary, npm package and POSIX audit

**Files:**
- Modify: `packages/cli/scripts/build-binary.ts` (add `{ suffix: 'win32-x64', target: 'bun-windows-x64' }` to `publishTargets`; outfile `aio-proxy.exe` when the suffix starts with `win32`)
- Create: `npm/cli-win32-x64/package.json` (copy of `npm/cli-linux-x64/package.json` with `os: ["win32"]`)
- Modify: `npm/aio-proxy/package.json` (`optionalDependencies` adds `"@aio-proxy/cli-win32-x64": "workspace:*"`), `npm/aio-proxy/bin/aio-proxy.js` (resolve `bin/aio-proxy.exe` on win32)
- Modify: `packages/cli/src/service/service.ts` (`managedServicePath(home, inherited, delimiter = path.delimiter)`), `packages/cli/src/desktop-connect/desktop-connect.ts` (`runWithin` adds `windowsHide: true`), `service.ts` `runManager` (same)
- Modify: `.changeset/config.json` (add `@aio-proxy/cli-win32-x64` to the `fixed` group), `bun.lock` (`bun install`)
- Test: `packages/cli/src/service/service.test.ts`

**Interfaces:**
- Produces: `managedServicePath(home: string, inherited: string | undefined, delimiter?: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
test('managed service PATH uses the platform delimiter and keeps Windows paths', () => {
  const path = managedServicePath('C:\\Users\\Zoë Chen', 'C:\\Windows\\System32;C:\\Tools', ';');
  expect(path.split(';').slice(0, 2)).toEqual(['C:\\Windows\\System32', 'C:\\Tools']);
  expect(path).not.toContain(':/usr/bin');
});
```

- [ ] **Step 2: Run** `cd packages/cli && bun run test:unit src/service/service.test.ts` — Expected: FAIL (`managedServicePath` not exported / joins with `:`).
- [ ] **Step 3: Implement.** Export `managedServicePath`; split and join `inherited` on `delimiter`; on `;` skip the POSIX fallbacks (`/opt/homebrew/bin` …) and use `path.win32.isAbsolute`. Add the build target, npm package, launcher branch and `windowsHide`.
- [ ] **Step 4: Run** the test file — Expected: PASS. Then `bun run build && bun packages/cli/scripts/build-binary.ts win32-x64` — Expected: `npm/cli-win32-x64/bin/aio-proxy.exe` exists. `bunx changeset status --verbose` with a scratch changeset — Expected: `@aio-proxy/cli-win32-x64` bumps with the others.
- [ ] **Step 5: Commit**

```bash
git add packages/cli npm
git commit -m "feat(cli): build and publish a Windows x64 binary"
```

### Task 3: Windows upgrade chain and desktop-copy upgrade protection

**Files:**
- Move: `packages/cli/src/upgrade/binary.ts` → `packages/cli/src/upgrade/binary/{index.ts,binary.ts}`; create `upgrade/binary/binary.test.ts`
- Modify: `upgrade/binary/binary.ts` (`extractBinaryFromTarball(bytes, platform)` reads `package/bin/aio-proxy.exe` on win32; `replaceBinaryForUpdate` win32 commit), `upgrade/detect.ts` (`PLATFORM_CLI_BIN` and the native-next-to-shim lookup accept `aio-proxy.exe`; PATH split on `path.delimiter`), `upgrade/upgrade.ts` (`isDesktopManagedInstall`)
- Test: `packages/cli/src/upgrade/upgrade.test.ts`, `upgrade/binary/binary.test.ts`

**Interfaces:**
- Consumes: existing `ReplaceOptions`, `sweepStaleBackups(targetPath)`.
- Produces: `isDesktopManagedInstall(env?, execPath?, realpath?, platform?: NodeJS.Platform): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a stable desktop copy reached without env markers is desktop-managed', () => {
  const real = (p: string) => p;
  expect(isDesktopManagedInstall({}, '/home/u/.local/share/aio-proxy-desktop/bin/aio-proxy', real, 'linux')).toBe(true);
  expect(isDesktopManagedInstall({}, 'C:\\Users\\U\\AppData\\Local\\AIO-Proxy-Desktop\\bin\\aio-proxy.exe', real, 'win32')).toBe(true);
  expect(isDesktopManagedInstall({}, '/home/u/.bun/bin/aio-proxy', real, 'linux')).toBe(false);
});

test('win32 commit renames the running binary aside before moving the staged one in', async () => {
  const ops: string[] = [];
  await commitStagedBinary({ target: 'C:\\b\\aio-proxy.exe', staged: 'C:\\b\\.aio-proxy.new', platform: 'win32',
    rename: async (from, to) => void ops.push(`${from} -> ${to}`) });
  expect(ops).toEqual(['C:\\b\\aio-proxy.exe -> C:\\b\\aio-proxy.exe.old', 'C:\\b\\.aio-proxy.new -> C:\\b\\aio-proxy.exe']);
});
```

  Also:

```ts
test('a Windows package tarball yields aio-proxy.exe', async () => {
  const tgz = await tarball({ 'package/bin/aio-proxy.exe': new Uint8Array([7]) });
  expect(await extractBinaryFromTarball(tgz, 'win32')).toEqual(new Uint8Array([7]));
});

test('the native win32 binary under an npm prefix is recognized as a package install', async () => {
  const exe = 'C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\@aio-proxy\\cli-win32-x64\\bin\\aio-proxy.exe';
  expect(isPlatformCliBinary(exe)).toBe(true);
});
```

- [ ] **Step 2: Run** `cd packages/cli && bun run test:unit src/upgrade` — Expected: FAIL.
- [ ] **Step 3: Implement** the path rule (split on both separators; match consecutive segments `aio-proxy-desktop`, `bin`, case-insensitive when `platform === 'win32'`) and `commitStagedBinary({ target, staged, platform, rename })` used by `replaceBinaryForUpdate`; on a failed second rename it renames `.old` back and rethrows. `sweepStaleBackups` also removes `<target>.old`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade
git commit -m "feat(cli): self-upgrade on Windows and protect desktop copies"
```

### Task 4: Desktop token on Windows

**Files:**
- Modify: `packages/core/src/desktop-token/desktop-token.ts`
- Test: `packages/core/src/desktop-token/desktop-token.test.ts`

**Interfaces:**
- Produces: `desktopTokenPath(home: string, options?: TokenOptions): string`; `TokenOptions` gains `platform?: NodeJS.Platform` and `localAppData?: string`. `readDesktopToken` / `ensureDesktopToken` keep their signatures and use `desktopTokenPath`.

- [ ] **Step 1: Write the failing tests**

```ts
test('win32 keeps one token per resolved home under LOCALAPPDATA', () => {
  const opts = { platform: 'win32' as const, localAppData: join(home, 'LocalAppData') };
  const a = desktopTokenPath('C:\\Users\\Zoë Chen\\.aio-proxy', opts);
  expect(a.startsWith(join(home, 'LocalAppData', 'aio-proxy', 'desktop-tokens'))).toBe(true);
  expect(desktopTokenPath('c:\\users\\zoë chen\\.aio-proxy\\', opts)).toBe(a);
  expect(desktopTokenPath('D:\\other-home', opts)).not.toBe(a);
});

test('win32 creates and reads the token without POSIX mode checks, and rejects a symlink', () => {
  const opts = { platform: 'win32' as const, localAppData: join(home, 'LocalAppData') };
  const token = ensureDesktopToken('C:\\h', opts);
  expect(readDesktopToken('C:\\h', opts)).toBe(token);
  const path = desktopTokenPath('C:\\h2', opts);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(join(home, 'elsewhere'), path);
  expect(readDesktopToken('C:\\h2', opts)).toBeUndefined();
  expect(rejectionOf(() => ensureDesktopToken('C:\\h2', opts))).toBe('not_regular_file');
});
```

- [ ] **Step 2: Run** `cd packages/core && bun test src/desktop-token` — Expected: FAIL.
- [ ] **Step 3: Implement.** win32: normalize with `path.win32.resolve`, strip a trailing separator, lowercase, then `sha256` hex; directory created with `mkdirSync(..., { recursive: true })` (inherits the profile ACL). `inspect` on win32: `lstatSync` first → symlink/junction → `not_regular_file`; skip `O_NOFOLLOW`, uid and mode checks. `localAppData` defaults to `process.env.LOCALAPPDATA`; a missing value throws `DesktopTokenRejectedError('unreadable')`.
- [ ] **Step 4:** Mark the existing POSIX-only tests (mode `0o600`, uid, `mkfifo`) `test.skipIf(process.platform === 'win32')`; every win32 test passes `localAppData` under the temp dir so no test touches the real profile. **Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/desktop-token
git commit -m "feat(core): keep the Windows desktop token in the user's LocalAppData"
```

### Task 5: Socket listings for Linux (`/proc/net/tcp`)

**Files:**
- Create: `packages/cli/src/desktop-connect/sockets/index.ts`, `sockets/sockets.ts`, `sockets/proc-net.ts`, `sockets/sockets.test.ts`
- Modify: `packages/cli/src/desktop-connect/verified-get.ts`, `desktop-connect.ts` (call `listSockets` instead of `lsof` directly)

**Interfaces:**
- Produces: `type Socket = { readonly owner: string; readonly family: 'IPv4' | 'IPv6'; readonly address: string }` (replaces the `uid: number` shape; `owner` is `String(uid)` on POSIX); `parseProcNetTcp(text: string, family: 'IPv4' | 'IPv6'): Socket[]` (address `local->remote` for connected rows, `host:port` or `*:port` for `LISTEN` rows, lsof spelling: IPv6 as `[addr]:port`); `listSockets(platform, port, deps): Promise<readonly Socket[]>`; `currentOwner(platform): Promise<string>`. `servesConnection` and `listensAt` take `owner: string`.

- [ ] **Step 1: Write the failing tests** (fixture rows copied from a real `/proc/net/tcp` and `tcp6`)

```ts
test('proc/net/tcp rows decode little-endian addresses into lsof spellings', () => {
  const v4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1029 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1
   1: 0100007F:1029 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 2 1`;
  expect(parseProcNetTcp(v4, 'IPv4')).toEqual([
    { owner: '1000', family: 'IPv4', address: '127.0.0.1:4137' },
    { owner: '1000', family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000' },
  ]);
  const v6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid
   0: 00000000000000000000000001000000:1029 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000
   1: 00000000000000000000000001000000:1029 00000000000000000000000001000000:C351 01 00000000:00000000 00:00000000 00000000  1000`;
  expect(parseProcNetTcp(v6, 'IPv6')).toEqual([
    { owner: '1000', family: 'IPv6', address: '[::1]:4137' },
    { owner: '1000', family: 'IPv6', address: '[::1]:4137->[::1]:50001' },
  ]);
});

test('another account serving the connection is not ours', () => {
  const sockets = [{ owner: '1001', family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000' }] as const;
  expect(servesConnection(sockets, '1000', '127.0.0.1:4137', '127.0.0.1:50000')).toBe(false);
});
```

- [ ] **Step 2: Run** `cd packages/cli && bun run test:unit src/desktop-connect` — Expected: FAIL.
- [ ] **Step 3: Implement** `parseProcNetTcp` (hex IPv4 is one little-endian 32-bit word; IPv6 is four little-endian words; `0A` = LISTEN, wildcard local → `*:port`), `listSockets` (darwin: existing `lsof` + `parseSockets` mapped to `owner`; linux: read `/proc/net/tcp` and `/proc/net/tcp6` filtered to `port` on either end), and switch `verified-get.ts` / `desktop-connect.ts` to `owner` and `listSockets`. Existing lsof tests keep passing with `owner`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/desktop-connect
git commit -m "feat(cli): verify connection owners on Linux through /proc"
```

### Task 6: Socket listings for Windows (`netstat` + `tasklist`)

**Files:**
- Create: `packages/cli/src/desktop-connect/sockets/netstat.ts`
- Modify: `sockets/sockets.ts`, `sockets/sockets.test.ts`

**Interfaces:**
- Consumes: Task 5's `Socket`, `listSockets`, `currentOwner`.
- Produces: `parseNetstat(text: string): { family: 'IPv4' | 'IPv6'; address: string; pid: number }[]`; `parseTasklistUser(csv: string): string | undefined`. win32 `currentOwner` = `whoami` output trimmed (`DOMAIN\user`); `listSockets('win32', …)` runs `netstat -ano -p TCP` and `netstat -ano -p TCPv6`, then `tasklist /V /FI "PID eq <pid>" /FO CSV /NH` per distinct PID.

- [ ] **Step 1: Write the failing tests**

```ts
test('netstat rows map to lsof spellings for both families', () => {
  const out = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:4137         0.0.0.0:0              LISTENING       812
  TCP    127.0.0.1:4137         127.0.0.1:50000        ESTABLISHED     812
  TCP    [::]:4137              [::]:0                 LISTENING       812
  TCP    [::1]:4137             [::1]:50001            ESTABLISHED     812`;
  expect(parseNetstat(out)).toEqual([
    { family: 'IPv4', address: '127.0.0.1:4137', pid: 812 },
    { family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000', pid: 812 },
    { family: 'IPv6', address: '*:4137', pid: 812 },
    { family: 'IPv6', address: '[::1]:4137->[::1]:50001', pid: 812 },
  ]);
});

test('tasklist user column names the owner; N/A is nobody', () => {
  expect(parseTasklistUser('"bun.exe","812","Console","1","90,000 K","Running","PC\\Zoë Chen","0:00:01","N/A"')).toBe('PC\\Zoë Chen');
  expect(parseTasklistUser('"x.exe","9","Services","0","1 K","Unknown","N/A","0:00:00","N/A"')).toBeUndefined();
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** both parsers and the win32 branch of `listSockets` (skip `TIME_WAIT`/`CLOSE_WAIT` rows; `0.0.0.0:port` and `[::]:port` listeners → `*:port`; owner comparison case-insensitive).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/desktop-connect/sockets
git commit -m "feat(cli): verify connection owners on Windows"
```

### Task 7: Windows unit files — task XML and `service.json`

**Files:**
- Create: `packages/cli/src/service/schtasks-unit/{index.ts,schtasks-unit.ts,schtasks-unit.test.ts}`
- Modify: `packages/cli/src/service/unit-templates.ts` (export `UnitOptions` env builder shared by all three renderers)

**Interfaces:**
- Consumes: `UnitOptions` (`exec`, `configPath`, `path`, `upgradeMethod`, `desktopExec`).
- Produces:
  - `TASK_FOLDER = '\\AIO Proxy\\'`; `taskPath(sid: string): string` → `\AIO Proxy\aio-proxy-<sid>`;
  - `type ServiceSpec = { readonly exec: string; readonly env: Readonly<Record<string, string>> }`;
  - `renderServiceSpec(o: UnitOptions): ServiceSpec`; `parseServiceSpec(text: string): ServiceSpec | undefined`;
  - `renderTaskXml(o: { sid: string; exec: string; specPath: string }): string` — action per the phase 0 finding (default `conhost.exe --headless "<exec>" __service-run "<specPath>"`), `LogonTrigger` with `UserId` = sid, `Principal` `UserId` = sid, `MultipleInstancesPolicy` `IgnoreNew`, `ExecutionTimeLimit` `PT0S`, `DisallowStartIfOnBatteries`/`StopIfGoingOnBatteries` false, `RestartOnFailure` `PT1M` × 3, UTF-16 declaration as `schtasks /XML` requires;
  - `parseTaskXml(xml: string): { sid: string; exec: string; specPath: string } | undefined` (reads back exactly what `renderTaskXml` writes, `undefined` for anything else);
  - `serviceSpecPath(localAppData: string)`, `serviceStatePath(localAppData: string)`.

- [ ] **Step 1: Write the failing tests**

```ts
const sid = 'S-1-5-21-1-2-3-1001';
const exec = 'C:\\Users\\Zoë Chen\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';

test('task XML round-trips an exec path with spaces, non-ASCII and XML metacharacters', () => {
  const odd = 'C:\\Tools & <Co>\\aio-proxy.exe';
  for (const e of [exec, odd]) {
    expect(parseTaskXml(renderTaskXml({ sid, exec: e, specPath: 'C:\\Users\\Zoë Chen\\AppData\\Local\\aio-proxy\\service.json' })))
      .toEqual({ sid, exec: e, specPath: 'C:\\Users\\Zoë Chen\\AppData\\Local\\aio-proxy\\service.json' });
  }
});

test('a task that runs anything but __service-run with a spec is not ours', () => {
  const xml = renderTaskXml({ sid, exec, specPath: 'C:\\s.json' }).replace('__service-run', 'run');
  expect(parseTaskXml(xml)).toBeUndefined();
});

test('service spec carries the desktop marker only for a desktop-owned unit', () => {
  const spec = renderServiceSpec({ exec, configPath: 'C:\\h\\config.jsonc', desktopExec: exec, upgradeMethod: 'desktop' });
  expect(spec.env).toMatchObject({ AIO_PROXY_HOME: 'C:\\h', AIO_PROXY_MANAGED: '1', AIO_PROXY_DESKTOP_EXEC: exec, AIO_PROXY_UPGRADE_METHOD: 'desktop' });
  expect(parseServiceSpec(JSON.stringify(spec))).toEqual(spec);
  expect(renderServiceSpec({ exec, configPath: 'C:\\h\\config.jsonc' }).env['AIO_PROXY_DESKTOP_EXEC']).toBeUndefined();
});
```

- [ ] **Step 2: Run** `cd packages/cli && bun run test:unit src/service` — Expected: FAIL.
- [ ] **Step 3: Implement** with `Bun.XML.stringify` for rendering (as `renderLaunchdPlist` does) and a parse that checks the action's command/arguments exactly; `parseServiceSpec` validates with `isPlainObject` and string-only env values.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/service
git commit -m "feat(cli): render the Windows task and service spec"
```

### Task 8: `__service-run` supervisor

**Files:**
- Create: `packages/cli/src/service-run/{index.ts,service-run.ts,service-run.test.ts}`, `packages/cli/src/win32-ffi/{index.ts,win32-ffi.ts,win32-ffi.test.ts}` (Job Object and `QueryFullProcessImageNameW`)
- Modify: `packages/cli/src/main.ts` (hidden command `__service-run <spec>` beside `__desktop-connect`), `packages/cli/src/exit/exit.ts` (`EXIT.restartRequested = 75`)

**Interfaces:**
- Consumes: Task 7's `parseServiceSpec`, `serviceStatePath`.
- Produces: `type Decision = 'stop' | 'relaunch-now' | 'relaunch-later'`; `decide(exitCode: number): Decision`; `runSupervisor(specPath: string, deps: SupervisorDeps): Promise<number>` where `SupervisorDeps = { readSpec, exists, spawnChild(exec, env): Promise<number>, writeState(pid), sleep(ms), pid }`; `createKillOnCloseJob(): JobHandle`, `assignToJob(job, pid)`, `processImagePath(pid: number): string | undefined` in `win32-ffi` (bun:ffi, win32 only).

- [ ] **Step 1: Write the failing tests**

```ts
test('exit codes map to systemd-like decisions', () => {
  expect(decide(0)).toBe('stop');
  expect(decide(1)).toBe('stop');
  expect(decide(75)).toBe('relaunch-now');
  expect(decide(2)).toBe('relaunch-later');
  expect(decide(137)).toBe('relaunch-later');
});

test('supervisor re-reads the spec on 75, backs off 5 s on a crash, and stops cleanly when exec vanishes', async () => {
  let spec = { exec: 'A', env: {} };
  const runs: string[] = []; const sleeps: number[] = []; let exists = true;
  const code = await runSupervisor('spec.json', {
    readSpec: () => spec, exists: () => exists, pid: 4242, writeState: () => {},
    sleep: async (ms) => void sleeps.push(ms),
    spawnChild: async (e) => {
      runs.push(e);
      if (runs.length === 1) { spec = { exec: 'B', env: {} }; return 75; }
      if (runs.length === 3) exists = false;
      return 2;
    },
  });
  expect(runs).toEqual(['A', 'B', 'B']);
  expect(sleeps).toEqual([5000, 5000]);
  expect(code).toBe(0);
});

test('an unreadable spec stops the supervisor with 1', async () => {
  expect(await runSupervisor('spec.json', { ...fakes, readSpec: () => undefined })).toBe(1);
});
```

- [ ] **Step 2: Run** `cd packages/cli && bun run test:unit src/service-run` — Expected: FAIL.
- [ ] **Step 3: Implement.** `runSupervisor` writes `{ pid }` to the state file first, then loops: read spec (unreadable → exit 1), `exists(exec)` false → return 0, spawn `<exec> run` with `{ ...process.env, ...spec.env }`, `windowsHide: true`, stdio ignored, assigned to the kill-on-close job on win32; apply `decide`. `job-object.ts` calls `CreateJobObjectW`, `SetInformationJobObject(JobObjectExtendedLimitInformation, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)`, `AssignProcessToJobObject` via `bun:ffi`; add one `test.skipIf(process.platform !== 'win32')` that kills the supervisor and asserts the child is gone.
- [ ] **Step 4: Run** — Expected: PASS (the Windows-only test is skipped on macOS/Linux).
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/service-run packages/cli/src/main.ts packages/cli/src/exit
git commit -m "feat(cli): supervise the Windows service with __service-run"
```

### Task 9: Windows lifecycle (`schtasks` backend)

**Files:**
- Create: `packages/cli/src/service/schtasks/{index.ts,schtasks.ts,schtasks.test.ts}`, `packages/cli/src/service/uninstall-marker/{index.ts,uninstall-marker.ts,uninstall-marker.test.ts}`, `packages/cli/src/service/run-capture/{index.ts,run-capture.ts}`
- Modify: `packages/cli/src/service/service.ts` (`SupportedPlatform` adds `'win32'`; dispatch install/start/stop/restart/uninstall/status), `managedUnitPath('win32')` returns the spec path

**Interfaces:**
- Consumes: Tasks 7–8; `runManager(cmd, allowFailure)` for mutating commands (output streamed to the user).
- Produces: `currentUserSid(run): Promise<string>` (`whoami /user /fo csv /nh`); `schtasksInstall`, `schtasksStart`, `schtasksStop`, `schtasksRestart`, `schtasksUninstall` — each `(io: SchtasksIo) => Promise<void>` with `SchtasksIo = { run, capture, sid, localAppData, exec, configPath, env, writeFile, rename, remove, readState, pidAlive, sleep, now }`; `runCapture(cmd): Promise<{ code: number; stdout: string; stderr: string }>` (windowsHide, captured) for every query; `queryTaskXml(capture, path): Promise<{ kind: 'found'; xml: string } | { kind: 'missing' } | { kind: 'failed' }>` (`schtasks /Query /XML /TN <path> /HRESULT`, `0x80070002` → missing). Uninstall marker helpers shared with Tasks 10 and 12: `uninstallMarkerPath(platform, env): string` (fixed per-user path from Global Constraints), `writeUninstallMarker`, `clearUninstallMarker`, `uninstallMarkerExists`.

- [ ] **Step 1: Write the failing tests** (fake `run` records argv; fake fs)

```ts
test('stop ends the task and disables it so the stop survives a logon', async () => {
  const calls = await recordCalls((io) => schtasksStop(io));
  expect(calls).toEqual([['schtasks', '/End', '/TN', path], ['schtasks', '/Change', '/TN', path, '/DISABLE']]);
});

test('restart after stop rewrites XML and spec, re-creates the task enabled, then runs it', async () => {
  const calls = await recordCalls((io) => schtasksRestart(io));
  expect(calls.map((c) => c[1])).toEqual(['/End', '/Create', '/Run']);
  expect(calls[1]).toContain('/F');
});

test('a failed re-create restores the previous XML and spec', async () => {
  const fs = fakeFs({ [specPath]: 'old-spec' });
  await expect(schtasksRestart(io({ fs, failOn: '/Create' }))).rejects.toThrow();
  expect(fs.read(specPath)).toBe('old-spec');
  expect(fs.lastXmlCreated()).toBe(previousXml);
});

test('uninstall waits for the supervisor to exit before deleting, then leaves the marker', async () => {
  const alive = [true, true, false];
  const { calls, fs } = await recordRun((io) => schtasksUninstall({ ...io, pidAlive: () => alive.shift() ?? false }));
  expect(calls.map((c) => c[1])).toEqual(['/End', '/Delete']);
  expect(fs.exists(specPath)).toBe(false);
  expect(fs.exists(uninstallMarkerPath('win32', env))).toBe(true);
});

test('uninstall fails without deleting when the supervisor outlives 10 s', async () => {
  await expect(schtasksUninstall(io({ pidAlive: () => true }))).rejects.toThrow();
  expect(recorded().some((c) => c[1] === '/Delete')).toBe(false);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Install: clear marker, write spec + XML (UTF-16LE file in a temp dir), `/Create /XML <file> /TN <path> /F` only after `queryTaskXml` returns `missing` or a task whose principal is `sid` (`failed` aborts). Restart keeps the `queryTaskXml` result as the rollback XML. Start: `/Change /ENABLE`, `/Run`. Restart: stage both files, `/End`, `/Create /F`, move spec into place, `/Run`; on any failure re-create from the previous XML and restore the spec. Uninstall: `/End`, poll `pidAlive(readState().pid)` every 100 ms up to 10 s, `/Delete /F`, remove spec and state, write marker. Status: `/Query /TN <path> /V /FO LIST` passthrough.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/service
git commit -m "feat(cli): manage the service with Task Scheduler on Windows"
```

### Task 10: Linux lifecycle persistence and the desktop marker in systemd units

**Files:**
- Modify: `packages/cli/src/service/service.ts` (linux branches), `packages/cli/src/service/unit-templates.ts` (`renderSystemdUnit` emits `Environment="AIO_PROXY_DESKTOP_EXEC=…"` when `desktopExec` is set), `service/systemd.ts`
- Modify: `packages/cli/src/service/service.ts` `readDesktopOwnedUnit(path, platform)` — linux parses the unit, win32 reads the spec
- Test: `packages/cli/src/service/service.test.ts`

**Interfaces:**
- Consumes: Task 9's uninstall-marker helpers; Task 7's `parseServiceSpec`.
- Produces: `readDesktopOwnedUnit(path?: string, platform?: NodeJS.Platform): boolean`; `parseSystemdUnit(text: string): { exec: string | null; env: Record<string, string> }` exported from `systemd.ts` for Task 11.

- [ ] **Step 1: Write the failing tests**

```ts
test('linux stop disables and start enables, so a stop survives a reboot', async () => {
  expect(await linuxCalls(serviceStop)).toEqual([['systemctl', '--user', 'disable', '--now', 'aio-proxy.service']]);
  expect(await linuxCalls(serviceStart)).toContainEqual(['systemctl', '--user', 'enable', '--now', 'aio-proxy.service']);
});

test('linux uninstall leaves the marker and install clears it', async () => {
  await linuxUninstall(); expect(existsSync(uninstallMarkerPath('linux', env))).toBe(true);
  await linuxInstall();   expect(existsSync(uninstallMarkerPath('linux', env))).toBe(false);
});

test('a desktop-owned systemd unit carries its own marker and is recognized', () => {
  const unit = renderSystemdUnit({ exec: link, configPath: '/h/config.jsonc', desktopExec: link });
  expect(parseSystemdUnit(unit)).toMatchObject({ exec: link, env: { AIO_PROXY_DESKTOP_EXEC: link } });
  writeFileSync(unitFile, unit);
  expect(readDesktopOwnedUnit(unitFile, 'linux')).toBe(true);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (restart also runs `enable` before `restart`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/service
git commit -m "fix(cli): keep a stopped or uninstalled Linux service stopped"
```

### Task 11: In-service restart on Windows

**Files:**
- Modify: `packages/cli/src/service/service.ts` (`serviceRestart`), `packages/cli/src/service/schtasks.ts`
- Test: `packages/cli/src/service/schtasks.test.ts`

**Interfaces:**
- Consumes: `EXIT.restartRequested` (Task 8), `schtasksRestart` (Task 9).
- Produces: `serviceRestart` on win32 with `env.AIO_PROXY_MANAGED === '1'` and no TTY: rewrites the spec (and the XML via `/Create /F` when `exec` changed), returns normally, and calls `io.scheduleExit(75, 1000)`; the default is a ref'd `setTimeout(() => process.exit(75), 1000)` (not `unref`, so the exit happens even when the event loop is otherwise idle).

- [ ] **Step 1: Write the failing test**

```ts
test('a managed proxy restarting itself on Windows rewrites the spec and asks its supervisor to relaunch', async () => {
  const exits: [number, number][] = [];
  const { calls } = await runRestart({ platform: 'win32', env: { AIO_PROXY_MANAGED: '1' }, isTTY: false, exec: newExec,
    scheduleExit: (code, ms) => void exits.push([code, ms]) });
  expect(calls.some((c) => c[1] === '/End' || c[1] === '/Run')).toBe(false);
  expect(calls.map((c) => c[1])).toEqual(['/Create']);
  expect(exits).toEqual([[75, 1000]]);
  expect(readSpec().exec).toBe(newExec);
});

test('the scheduled exit really ends the process with 75 after the caller returned', async () => {
  // spawn `bun -e` running serviceRestart with a real scheduleExit and fakes for schtasks;
  // assert the child printed "returned" and exited with code 75
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; outside the service (TTY or not managed) keep Task 9's path.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/service
git commit -m "fix(cli): restart a Windows service from inside without killing it"
```

### Task 12: `__desktop-connect` on Linux and Windows

**Files:**
- Create: `packages/cli/src/desktop-connect/systemd-inspect/{index.ts,systemd-inspect.ts,systemd-inspect.test.ts}`, `desktop-connect/schtasks-inspect/{index.ts,schtasks-inspect.ts,schtasks-inspect.test.ts}`
- Modify: `packages/cli/src/desktop-connect/desktop-connect.ts` (`DesktopConnectDeps.plistPath` → `unitPath`; `readUnit`/`readJob` dispatch on `deps.platform`; owner via `deps.owner: string`), `desktop-connect.test.ts`

**Interfaces:**
- Consumes: Task 5–6 `listSockets`/`currentOwner`; Task 7 `parseTaskXml`, `parseServiceSpec`, `serviceStatePath`; Task 9 marker; Task 10 `parseSystemdUnit`.
- Produces:
  - `inspectSystemdUnit(text: string): UnitInspection`; `parseSystemctlShow(stdout: string, code: number, markerExists: boolean): { loaded: boolean; disabled: boolean; pid: number | null }`;
  - `inspectTask(xml: string | undefined, spec: string | undefined, sid: string): UnitInspection`; `parseSchtasksCsv(stdout: string, code: number, markerExists: boolean, state: { pid: number } | undefined, pidAliveAs: (pid: number, exec: string) => boolean, exec: string | null): { loaded; disabled; pid }`.

- [ ] **Step 1: Write the failing tests** — the `disabled` table from the spec, both platforms:

```ts
test.each([
  ['no unit, no marker', 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\nMainPID=0', 0, false, false],
  ['no unit, marker',    'LoadState=not-found\nActiveState=inactive\nUnitFileState=\nMainPID=0', 0, true,  true],
  ['disabled unit',      'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0', 0, false, true],
  ['query failed',       '', 1, false, true],
])('systemd %s → disabled=%s', (_n, out, code, marker, disabled) => {
  expect(parseSystemctlShow(out, code, marker).disabled).toBe(disabled);
});

test('systemd running unit reports MainPID so matchesJob works', () => {
  expect(parseSystemctlShow('LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=812', 0, false))
    .toEqual({ loaded: true, disabled: false, pid: 812 });
});

test('a task owned by another principal, or running something else, is unknown', () => {
  expect(unitOwner(inspectTask(xmlFor('S-1-5-21-9'), spec, sid), link, () => true)).toBe('unknown');
  expect(unitOwner(inspectTask(xmlFor(sid).replace('__service-run', 'run'), spec, sid), link, () => true)).toBe('unknown');
});

test('Windows job pid comes from the state file only while that process runs exec', () => {
  expect(parseSchtasksCsv(runningCsv, 0, false, { pid: 77 }, () => true, link).pid).toBe(77);
  expect(parseSchtasksCsv(runningCsv, 0, false, { pid: 77 }, () => false, link).pid).toBeNull();
});

test('a process with the same image name in another directory is not the job', () => {
  const imagePath = (pid: number) => (pid === 77 ? 'C:\\Other\\aio-proxy.exe' : undefined);
  expect(pidAliveAs(77, link, imagePath)).toBe(false);
});
```

  Plus one end-to-end `desktopConnect` test per platform with fake deps: linux desktop-owned running instance → `owner: 'desktop'`, `matchesJob: true`, token present; win32 same with the state-file pid as the instance's `ppid`.

- [ ] **Step 2: Run** `cd packages/cli && bun run test:unit src/desktop-connect` — Expected: FAIL.
- [ ] **Step 3: Implement.** linux: `readUnit` reads the unit file; `readJob` runs `systemctl --user show aio-proxy.service -p LoadState,ActiveState,UnitFileState,MainPID`. win32: `queryTaskXml` (Task 9) + spec file; `schtasks /Query /TN <path> /V /FO CSV /NH /HRESULT` (`missing` → "no unit", other failure → `disabled: true`); `pidAliveAs(pid, exec)` = `processImagePath(pid)` (Task 8 `win32-ffi`) equals `exec` case-insensitively. Marker via `uninstallMarkerExists(platform, env)`. Identity probes and listener checks call `listSockets(deps.platform, …)`.
- [ ] **Step 4: Run** — Expected: PASS, darwin tests unchanged.
- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/desktop-connect
git commit -m "feat(cli): discover the managed service on Linux and Windows"
```

### Task 13: CI on Windows and the release note

**Files:**
- Modify: `.github/workflows/ci.yml` (job `cli-windows`: `windows-2025`, `bun install --frozen-lockfile`, `bun run build`, `cd packages/cli && bun run test:unit src/service src/service-run src/win32-ffi src/desktop-connect src/upgrade`, `cd packages/core && bun test src/desktop-token`)
- Modify: `packages/i18n/messages/*.json` (any new `cli.service.*` messages added in Tasks 9–11, all five locales)
- Create: `.changeset/windows-cli-service.md`

- [ ] **Step 1:** Add the job; push the branch; Expected: the job is green, including the Windows-only Job Object test.
- [ ] **Step 2:** `bun changeset` → packages `aio-proxy`, `@aio-proxy/cli`, `@aio-proxy/core`, all `minor`; body (one paragraph): the CLI now ships for Windows x64 with `aio-proxy service` backed by a per-user scheduled task, and on Linux and Windows a stopped or uninstalled service now stays stopped.
- [ ] **Step 3: Run** `bun run preflight` — Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml packages/i18n .changeset
git commit -m "ci(cli): run service and discovery tests on Windows"
```
