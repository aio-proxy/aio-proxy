// Packages the Linux AppImage or the Windows NSIS installer into desktop/target/package/<asset>
// (spec section 6). Native builds only: run it on a runner of the target's OS and architecture.
//
//   --target <linux-x86_64|linux-aarch64|windows-x86_64>
//   --version <x.y.z>   stamped into the app and its sidecar for this build only
//   --rehearsal         allows AIO_PROXY_DESKTOP_FEED_URL / AIO_PROXY_DESKTOP_UPDATE_KEY, and names
//                       the asset *-rehearsal
// Env: WINDOWS_SIGN_COMMAND becomes cargo-packager's windows.sign_command (`%1` is the file); it
// signs the app, the installer and the uninstaller.
// Needs cargo-packager 0.11.8: `cargo install cargo-packager --version 0.11.8 --locked`.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import { assetName, checkRehearsalEnv, packagerConfig, targetBuild, withVersion } from './package/index';

const PACKAGER_VERSION = '0.11.8';
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
const packager = (await $`cargo packager --version`.cwd(desktop).nothrow().quiet()).stdout.toString().trim();
if (!packager.endsWith(` ${PACKAGER_VERSION}`)) {
  throw new Error(
    `needs cargo-packager ${PACKAGER_VERSION} (cargo install cargo-packager --version ${PACKAGER_VERSION} --locked), found "${packager}"`,
  );
}

step('2. bun run build');
await $`bun run build`.cwd(root);

// The app reads its version from npm/aio-proxy/package.json (build.rs) and the sidecar from
// packages/cli/package.json, so a build for another version stamps both and restores them after.
const exe = build.format === 'nsis' ? '.exe' : '';
const sidecarDir = join(out, 'sidecar');
const sidecar = join(sidecarDir, `aio-proxy-${build.triple}${exe}`);
const app = join(desktop, 'target', 'release', `aio-proxy-desktop${exe}`);
const manifests = ['npm/aio-proxy/package.json', 'packages/cli/package.json'].map((path) => join(root, path));
const originals = await Promise.all(manifests.map((path) => Bun.file(path).text()));
const restore = (): void => manifests.forEach((path, i) => writeFileSync(path, originals[i] ?? ''));
// Ctrl-C or a cancelled CI step must not leave the stamped versions behind.
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

  step('4. cargo build --release');
  await $`cargo build --release --locked`.cwd(desktop);

  for (const binary of [sidecar, app]) {
    const reported = (await $`${binary} --version`.text()).trim();
    if (reported !== version) throw new Error(`${binary} --version printed ${reported}, expected ${version}`);
  }
} finally {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  restore();
}

step(`5. cargo packager --formats ${build.format}`);
// A --config replaces Cargo.toml's [package.metadata.packager] instead of merging with it, so the
// table is read here and completed. As an inline JSON string it keeps the cwd (desktop/), which
// Cargo.toml's relative paths are written against.
const metadata = (
  JSON.parse(await $`cargo metadata --no-deps --format-version 1`.cwd(desktop).text()) as {
    packages: { metadata: { packager: { nsis?: object } } }[];
  }
).packages[0]?.metadata.packager;
if (metadata === undefined) throw new Error('desktop/Cargo.toml has no [package.metadata.packager]');
const packagerOut = join(out, 'packager');
rmSync(packagerOut, { recursive: true, force: true });
const config = {
  ...metadata,
  version,
  targetTriple: build.triple,
  binariesDir: join(desktop, 'target', 'release'),
  outDir: packagerOut,
  // cargo-packager appends `-<triple>[.exe]` and installs it as aio-proxy[.exe] beside the app.
  externalBinaries: [join(sidecarDir, 'aio-proxy')],
  resources: [join(sidecarDir, 'THIRD_PARTY_NOTICES')],
  nsis: {
    ...metadata.nsis,
    preinstallSection: await Bun.file(join(desktop, 'packaging', 'uninstall-cleanup.nsh')).text(),
  },
  ...(signCommand === undefined ? {} : { windows: { signCommand } }),
};
await $`cargo packager --formats ${build.format} --config ${JSON.stringify(config)}`.cwd(desktop);

const built = readdirSync(packagerOut).filter((name) => name.endsWith(build.extension));
if (built.length !== 1) throw new Error(`expected one ${build.extension} in ${packagerOut}, found ${built.join(', ')}`);
const image = join(packagerOut, built[0] ?? '');
if (build.format === 'appimage') await repackAppImage(image);
rmSync(join(out, asset), { force: true });
renameSync(image, join(out, asset));
step(`done: ${join(out, asset)}`);

/**
 * Fixes two things linuxdeploy does, then rebuilds the image.
 *
 * linuxdeploy gives every ELF in usr/bin a `$ORIGIN/../lib` RUNPATH with patchelf. On arm64 that grows a Bun
 * `--compile` executable by a 64 KiB page and moves its embedded payload, so the CLI segfaults. The CLI links no
 * bundled library, so its original bytes go back in: the image is rebuilt from the same runtime and a squashfs
 * with the same compression, downloading nothing.
 *
 * linuxdeploy also re-points the AppDir root icon at a small hicolor size (32x32); launchers that read it show a
 * blurry icon, so it goes back to the largest one, the same file cargo-packager copied to .DirIcon.
 */
async function repackAppImage(image: string): Promise<void> {
  step('6. restore the sidecar linuxdeploy patched and the root icon');
  const work = join(packagerOut, 'repack');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  const offset = Number((await $`${image} --appimage-offset`.text()).trim());
  if (!Number.isInteger(offset) || offset <= 0) throw new Error(`${image} reported no squashfs offset`);
  await $`${image} --appimage-extract`.cwd(work).quiet();
  const root = join(work, 'squashfs-root');
  copyFileSync(sidecar, join(root, 'usr', 'bin', 'aio-proxy'));
  chmodSync(join(root, 'usr', 'bin', 'aio-proxy'), 0o755);
  const largestIcon = 'usr/share/icons/hicolor/512x512/apps/aio-proxy-desktop.png';
  if (!existsSync(join(root, largestIcon))) throw new Error(`${image} has no ${largestIcon}`);
  rmSync(join(root, 'aio-proxy-desktop.png'), { force: true });
  symlinkSync(largestIcon, join(root, 'aio-proxy-desktop.png'));
  const info = await $`unsquashfs -o ${offset} -s ${image}`.text();
  const compression = /Compression (\w+)/u.exec(info)?.[1];
  if (compression === undefined) throw new Error(`cannot read the squashfs compression of ${image}`);
  const squashfs = join(work, 'image.squashfs');
  await $`mksquashfs ${root} ${squashfs} -root-owned -noappend -comp ${compression}`.quiet();
  // Both parts are read into memory: a BunFile inside a Blob is silently dropped by Bun.write.
  const runtime = new Uint8Array(await Bun.file(image).slice(0, offset).arrayBuffer());
  const filesystem = new Uint8Array(await Bun.file(squashfs).arrayBuffer());
  await Bun.write(image, new Blob([runtime, filesystem]));
  chmodSync(image, 0o755);
  await $`unsquashfs -o ${offset} -s ${image}`.quiet();
  rmSync(work, { recursive: true, force: true });
}
