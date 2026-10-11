// Packages the Linux AppImage or the Windows NSIS installer into desktop/target/package/<asset>
// (spec section 6). Native builds only: run it on a runner of the target's OS and architecture.
//
//   --target <linux-x86_64|linux-aarch64|windows-x86_64>
//   --version <x.y.z>   stamped into the app and its sidecar for this build only
//   --rehearsal         allows AIO_PROXY_DESKTOP_FEED_URL / AIO_PROXY_DESKTOP_UPDATE_KEY, and names
//                       the asset *-rehearsal
// Env: WINDOWS_SIGN_COMMAND signs a file (`%1` is the path). It runs on the app and the installer.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import { assetName, checkRehearsalEnv, packagerConfig, targetBuild, withVersion } from './package/index';

// type2-runtime 20251108. The continuous tag moves, so the digest is the GitHub release asset's.
const appImageRuntimeSHA256: Record<string, string> = {
  'runtime-aarch64': '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444',
  'runtime-x86_64': '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
};

const NATIVE_TARGETS: Record<string, string> = {
  'linux-x64': 'linux-x86_64',
  'linux-arm64': 'linux-aarch64',
  'win32-x64': 'windows-x86_64',
};

const root = join(import.meta.dir, '..', '..');
const desktop = join(root, 'desktop');
const out = join(desktop, 'target', 'package');

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: 'string' },
    version: { type: 'string' },
    rehearsal: { type: 'boolean', default: false },
  },
});
const { target, version, rehearsal } = values;
if (target === undefined || version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
  console.error(
    'Usage: desktop:package --target <linux-x86_64|linux-aarch64|windows-x86_64> --version <x.y.z> [--rehearsal]',
  );
  process.exit(2);
}
const build = targetBuild(target);
const asset = assetName(target, version, rehearsal);
checkRehearsalEnv(process.env, rehearsal);
const { signCommand } = packagerConfig(version, process.env);
if (NATIVE_TARGETS[`${process.platform}-${process.arch}`] !== target) {
  throw new Error(`${target} must be packaged on its own OS and architecture, not ${process.platform}-${process.arch}`);
}

const step = (name: string): void => console.error(`\n==> ${name}`);

step('1. verify tools');
const goVersion = (await $`go version`.nothrow().quiet()).stdout.toString().trim();
if (!goVersion.startsWith('go version')) throw new Error(`needs Go, found "${goVersion}"`);
if (build.format === 'appimage') {
  const squash = (await $`mksquashfs -version`.nothrow().quiet()).exitCode;
  if (squash !== 0) throw new Error('needs mksquashfs (squashfs-tools)');
}
if (build.format === 'nsis') {
  const nsis = (await $`makensis -VERSION`.nothrow().quiet()).exitCode;
  if (nsis !== 0) throw new Error('needs makensis (NSIS 3)');
}

step('2. bun run build');
await $`bun run build`.cwd(root);

const exe = build.format === 'nsis' ? '.exe' : '';
const sidecarDir = join(out, 'sidecar');
const sidecar = join(sidecarDir, `aio-proxy-${build.triple}${exe}`);
const app = join(desktop, 'target', 'release', `aio-proxy-desktop${exe}`);
const manifests = ['npm/aio-proxy/package.json', 'packages/cli/package.json'].map((path) => join(root, path));
const originals = await Promise.all(manifests.map((path) => Bun.file(path).text()));
const restore = (): void => manifests.forEach((path, i) => writeFileSync(path, originals[i] ?? ''));
const onSignal = (signal: NodeJS.Signals): void => {
  restore();
  process.exit(signal === 'SIGINT' ? 130 : 143);
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
try {
  await Promise.all(manifests.map((path, i) => Bun.write(path, withVersion(originals[i] ?? '', version))));

  step(`3. build-binary.ts ${build.sidecar}`);
  rmSync(sidecarDir, { recursive: true, force: true });
  await $`bun packages/cli/scripts/build-binary.ts ${build.sidecar} ${sidecar}`.cwd(root);

  step('4. go build');
  const ldflags = ['-s', '-w', `-X github.com/aio-proxy/aio-proxy/desktop/internal/version.App=${version}`];
  if (build.format === 'nsis') ldflags.push('-H=windowsgui');
  const feed = process.env['AIO_PROXY_DESKTOP_FEED_URL'];
  const key = process.env['AIO_PROXY_DESKTOP_UPDATE_KEY'];
  if (feed !== undefined) ldflags.push(`-X github.com/aio-proxy/aio-proxy/desktop/internal/update.FeedURL=${feed}`);
  if (key !== undefined) ldflags.push(`-X github.com/aio-proxy/aio-proxy/desktop/internal/update.PublicKeyB64=${key}`);
  await $`go build -trimpath -ldflags=${ldflags.join(' ')} -o ${app} .`
    .cwd(desktop)
    .env({ ...process.env, CGO_ENABLED: '0' });

  for (const binary of [sidecar, app]) {
    const reported = (await $`${binary} --version`.text()).trim();
    if (reported !== version) throw new Error(`${binary} --version printed ${reported}, expected ${version}`);
  }
  if (signCommand !== undefined) await sign(signCommand, app);
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  restore();
}

const packagerOut = join(out, 'packager');
rmSync(packagerOut, { recursive: true, force: true });
mkdirSync(packagerOut, { recursive: true });
const image = join(packagerOut, `built${build.extension}`);
if (build.format === 'appimage') {
  step('5. assemble AppImage');
  await assembleAppImage(image);
} else {
  step('5. assemble NSIS installer');
  await assembleNsis(image);
  if (signCommand !== undefined) await sign(signCommand, image);
}
rmSync(join(out, asset), { force: true });
renameSync(image, join(out, asset));
step(`done: ${join(out, asset)}`);

async function sign(command: string, file: string): Promise<void> {
  const rendered = command.replaceAll('%1', file);
  if (process.platform === 'win32') await $`cmd /c ${rendered}`;
  else await $`sh -c ${rendered}`;
}

async function assembleAppImage(image: string): Promise<void> {
  const appDir = join(packagerOut, 'AppDir');
  const bin = join(appDir, 'usr', 'bin');
  const iconDir = join(appDir, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps');
  mkdirSync(bin, { recursive: true });
  mkdirSync(iconDir, { recursive: true });
  copyFileSync(app, join(bin, 'aio-proxy-desktop'));
  copyFileSync(sidecar, join(bin, 'aio-proxy'));
  chmodSync(join(bin, 'aio-proxy-desktop'), 0o755);
  chmodSync(join(bin, 'aio-proxy'), 0o755);
  copyFileSync(join(desktop, 'packaging', 'icons', '512x512.png'), join(iconDir, 'aio-proxy-desktop.png'));
  symlinkSync('usr/share/icons/hicolor/512x512/apps/aio-proxy-desktop.png', join(appDir, 'aio-proxy-desktop.png'));
  symlinkSync('aio-proxy-desktop.png', join(appDir, '.DirIcon'));
  writeFileSync(
    join(appDir, 'aio-proxy-desktop.desktop'),
    '[Desktop Entry]\nCategories=Development;\nExec=aio-proxy-desktop\nIcon=aio-proxy-desktop\nName=AIO Proxy\nStartupWMClass=aio-proxy-desktop\nTerminal=false\nType=Application\n',
  );
  writeFileSync(
    join(appDir, 'AppRun'),
    '#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/aio-proxy-desktop" "$@"\n',
  );
  chmodSync(join(appDir, 'AppRun'), 0o755);
  const runtime = await appImageRuntime();
  const squashfs = join(packagerOut, 'image.squashfs');
  await $`mksquashfs ${appDir} ${squashfs} -root-owned -noappend -comp gzip`.quiet();
  const header = new Uint8Array(await Bun.file(runtime).arrayBuffer());
  const filesystem = new Uint8Array(await Bun.file(squashfs).arrayBuffer());
  await Bun.write(image, new Blob([header, filesystem]));
  chmodSync(image, 0o755);
}

async function appImageRuntime(): Promise<string> {
  const name = process.arch === 'arm64' ? 'runtime-aarch64' : 'runtime-x86_64';
  const digest = appImageRuntimeSHA256[name];
  if (digest === undefined) throw new Error(`no pinned AppImage runtime for ${name}`);
  const path = join(desktop, '.cache', 'appimage', `20251108-${name}`);
  if (!existsSync(path) || (await sha256File(path)) !== digest) {
    mkdirSync(join(desktop, '.cache', 'appimage'), { recursive: true });
    const url = `https://github.com/AppImage/type2-runtime/releases/download/20251108/${name}`;
    step(`download ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`download ${url}: ${response.status}`);
    await Bun.write(path, new Uint8Array(await response.arrayBuffer()));
    const got = await sha256File(path);
    if (got !== digest) {
      rmSync(path, { force: true });
      throw new Error(`AppImage runtime ${name} sha256 ${got}, expected ${digest}`);
    }
  }
  chmodSync(path, 0o755);
  return path;
}

async function sha256File(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
}

async function assembleNsis(image: string): Promise<void> {
  const cleanup = readFileSync(join(desktop, 'packaging', 'uninstall-cleanup.nsh'), 'utf8')
    .replaceAll(
      'nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"\n  Pop $R0',
      'nsExec::ExecToLog \'cmd /c tasklist /NH /FI "IMAGENAME eq ${MAINBINARYNAME}.exe" | find /I "${MAINBINARYNAME}.exe"\'\n  Pop $R0',
    )
    .replaceAll(
      'nsis_tauri_utils::KillProcess "${MAINBINARYNAME}.exe"\n    Pop $R0',
      "nsExec::ExecToLog 'taskkill /F /IM ${MAINBINARYNAME}.exe'\n    Pop $R0",
    );
  const cleanupPath = join(packagerOut, 'cleanup.nsh');
  writeFileSync(cleanupPath, cleanup);
  const script = join(packagerOut, 'installer.nsi');
  const notices = join(sidecarDir, 'THIRD_PARTY_NOTICES');
  writeFileSync(
    script,
    `
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include nsExec.nsh
!define MAINBINARYNAME "aio-proxy-desktop"
!define PRODUCTNAME "AIO Proxy"
Name "AIO Proxy"
!include "${join(desktop, 'packaging', 'install-ui.nsh').replaceAll('\\', '\\\\')}"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
LangString appRunning \${LANG_ENGLISH} "\${PRODUCTNAME} is running! Please close it first then try again."
LangString appRunningOkKill \${LANG_ENGLISH} "\${PRODUCTNAME} is running!$\\nClick OK to kill it"
LangString failedToKillApp \${LANG_ENGLISH} "Failed to kill \${PRODUCTNAME}. Please close it first then try again"
OutFile "${image.replaceAll('\\', '\\\\')}"
InstallDir "$LOCALAPPDATA\\AIO Proxy"
RequestExecutionLevel user
Section
  !insertmacro AioProxyCloseRunning
  SetOutPath $INSTDIR
  File "${app.replaceAll('\\', '\\\\')}"
  File /oname=aio-proxy.exe "${sidecar.replaceAll('\\', '\\\\')}"
  ${existsSync(notices) ? `File /oname=THIRD_PARTY_NOTICES "${notices.replaceAll('\\', '\\\\')}"` : ''}
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  !insertmacro AioProxyInstallShell
SectionEnd
!include "${cleanupPath.replaceAll('\\', '\\\\')}"
Section Uninstall
  !insertmacro AioProxyUninstallShell
  Delete "$INSTDIR\\aio-proxy-desktop.exe"
  Delete "$INSTDIR\\aio-proxy.exe"
  Delete "$INSTDIR\\THIRD_PARTY_NOTICES"
  Delete "$INSTDIR\\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
`,
  );
  await $`makensis ${script}`;
}
