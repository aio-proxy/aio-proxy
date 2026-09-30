// The only entry point that assembles the macOS app: `bun run desktop:bundle --unsigned`.
// Phase 2 implements the unsigned path (steps 1-8 of the spec's Bundle command, ending in an ad-hoc
// signature). Release signing and notarization extend this file in Phase 3.
//
//   --unsigned           required for now; stops after the ad-hoc signature
//   --sidecar <path>     reuse an already-built `aio-proxy` (with THIRD_PARTY_NOTICES beside it)
//                        instead of `bun run build` + build-binary.ts
// Env: SPARKLE_PUBLIC_ED_KEY enables the updater; SPARKLE_FEED_URL overrides the release feed.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import { DEFAULT_FEED_URL, renderInfoPlist } from './info-plist';
import { MINIMUM_MACOS, machOProblems } from './macho';
import { runtimeSmoke } from './smoke';
import { fetchSparkle } from './sparkle';

const root = join(import.meta.dir, '..', '..');
const desktop = join(root, 'desktop');
const out = join(desktop, 'target', 'bundle');
const app = join(out, 'AIO Proxy.app');

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { unsigned: { type: 'boolean', default: false }, sidecar: { type: 'string' } },
});
if (!values.unsigned) {
  console.error('Only `--unsigned` is implemented; release signing lands with the release pipeline.');
  process.exit(2);
}

const step = (name: string): void => console.error(`\n==> ${name}`);

step('1. verify tools');
for (const tool of ['cargo', 'codesign', 'vtool', 'lipo', 'ditto', 'tar']) {
  if (Bun.which(tool) === null) throw new Error(`missing tool: ${tool}`);
}
const sparkle = await fetchSparkle(join(desktop, 'vendor'));
const version = ((await Bun.file(join(root, 'npm/aio-proxy/package.json')).json()) as { version: string }).version;

let sidecar = values.sidecar;
if (sidecar === undefined) {
  step('2. bun run build');
  await $`bun run build`.cwd(root);
  step('3. build-binary.ts darwin-arm64');
  sidecar = join(out, 'sidecar', 'aio-proxy');
  await $`bun packages/cli/scripts/build-binary.ts darwin-arm64 ${sidecar}`.cwd(root);
} else {
  step('2-3. reuse --sidecar');
}
const notices = join(dirname(sidecar), 'THIRD_PARTY_NOTICES');
if (!existsSync(notices)) throw new Error(`${notices} is missing`);

step('4. cargo build --release');
await $`cargo build --release --target aarch64-apple-darwin`
  .cwd(desktop)
  .env({ ...process.env, MACOSX_DEPLOYMENT_TARGET: MINIMUM_MACOS, SPARKLE_DIR: sparkle });

step('5. assemble the .app');
rmSync(app, { recursive: true, force: true });
for (const dir of ['MacOS', 'Frameworks', 'Resources']) mkdirSync(join(app, 'Contents', dir), { recursive: true });
const host = join(app, 'Contents/MacOS/aio-proxy-desktop');
const bundledSidecar = join(app, 'Contents/MacOS/aio-proxy');
cpSync(join(desktop, 'target/aarch64-apple-darwin/release/aio-proxy-desktop'), host);
cpSync(sidecar, bundledSidecar);
const framework = join(app, 'Contents/Frameworks/Sparkle.framework');
// ditto keeps the framework's Versions/Current symlinks.
await $`ditto ${join(sparkle, 'Sparkle.framework')} ${framework}`;
await Bun.write(
  join(app, 'Contents/Resources/THIRD_PARTY_NOTICES'),
  `${await Bun.file(notices).text()}\n\n--- Sparkle ---\n\n${await Bun.file(join(sparkle, 'LICENSE')).text()}`,
);
const publicEdKey = process.env['SPARKLE_PUBLIC_ED_KEY'];
await Bun.write(
  join(app, 'Contents/Info.plist'),
  renderInfoPlist({
    version,
    ...(publicEdKey === undefined || publicEdKey === ''
      ? {}
      : { sparkle: { feedUrl: process.env['SPARKLE_FEED_URL'] ?? DEFAULT_FEED_URL, publicEdKey } }),
  }),
);
await $`plutil -lint ${join(app, 'Contents/Info.plist')}`.quiet();

step('6. architecture, minos and dyld checks');
const sparkleBinaries = [
  join(framework, 'Versions/B/Sparkle'),
  join(framework, 'Versions/B/Autoupdate'),
  join(framework, 'Versions/B/Updater.app/Contents/MacOS/Updater'),
  join(framework, 'Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer'),
  join(framework, 'Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader'),
];
const machOs = [
  { path: host, exactArm64: true },
  { path: bundledSidecar, exactArm64: true },
  // Sparkle 2.10.0 ships universal binaries; they are kept as shipped.
  ...sparkleBinaries.map((path) => ({ path, exactArm64: false })),
];
const problems: string[] = [];
for (const { path, exactArm64 } of machOs) {
  problems.push(
    ...machOProblems({
      path,
      exactArm64,
      archs: await $`lipo -archs ${path}`.text(),
      vtool: await $`vtool -show-build ${path}`.text(),
    }),
  );
}
if (problems.length > 0) throw new Error(`Mach-O checks failed:\n${problems.join('\n')}`);

// The host runs only if dyld resolves Sparkle through the rpath.
const hostRuns = async (when: string): Promise<void> => {
  const reported = (await $`${host} --version`.text()).trim();
  if (reported !== version)
    throw new Error(`${when}: aio-proxy-desktop --version printed ${reported}, expected ${version}`);
};
await hostRuns('before signing');

step('7. runtime smoke');
await runtimeSmoke(app, version);

step('8. ad-hoc hardened signature (inside-out, Sparkle 2.10.0 order)');
// An ad-hoc signature has no Team ID, so hardened-runtime library validation would reject Sparkle;
// the host gets disable-library-validation for this build only. Developer ID signing never uses it.
const sign = (path: string, ...extra: string[]) => $`codesign -f -s - -o runtime ${extra} ${path}`.quiet();
await sign(join(framework, 'Versions/B/XPCServices/Installer.xpc'));
await sign(join(framework, 'Versions/B/XPCServices/Downloader.xpc'), '--preserve-metadata=entitlements');
await sign(join(framework, 'Versions/B/Autoupdate'));
await sign(join(framework, 'Versions/B/Updater.app'));
await sign(framework);
await sign(bundledSidecar, '--entitlements', join(desktop, 'entitlements/aio-proxy.plist'));
const hostEntitlements = ['--entitlements', join(desktop, 'entitlements/adhoc-host.plist')];
await sign(host, ...hostEntitlements);
// Signing the .app re-signs its main executable, so the host entitlement goes on this step too.
await sign(app, ...hostEntitlements);
await $`codesign --verify --deep --strict --verbose=2 ${app}`;
await hostRuns('after signing');

console.error(`\n${app}`);
