// The only entry point that assembles the macOS app (spec "Bundle command").
//
//   --unsigned           CI smoke: stops after an ad-hoc hardened signature
//   --release            Developer ID signature, then a notarized, stapled .app and .dmg
//   --sidecar <path>     reuse an already-built `aio-proxy` (with THIRD_PARTY_NOTICES beside it)
//                        instead of `bun run build` + build-binary.ts
// Env (--unsigned): SPARKLE_PUBLIC_ED_KEY enables the updater; SPARKLE_FEED_URL overrides the feed.
// Env (--release): DEVELOPER_ID_IDENTITY, SPARKLE_PUBLIC_ED_KEY, and APPLE_API_KEY_PATH +
// APPLE_API_KEY_ID + APPLE_API_ISSUER_ID or NOTARY_PROFILE; SPARKLE_FEED_URL only for local update
// rehearsals (desktop:publish refuses such a build).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { $ } from 'bun';

import { APP_NAME, buildDmg, dmgName } from './dmg';
import { DEFAULT_FEED_URL, renderInfoPlist } from './info-plist';
import { MINIMUM_MACOS, machOProblems } from './macho';
import { notarize } from './notary';
import { releaseEnv } from './release-env';
import { signApp } from './signing';
import { runtimeSmoke } from './smoke';
import { fetchSparkle } from './sparkle';

const root = join(import.meta.dir, '..', '..');
const desktop = join(root, 'desktop');
const out = join(desktop, 'target', 'bundle');
const app = join(out, APP_NAME);
const entitlements = join(desktop, 'entitlements');

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    unsigned: { type: 'boolean', default: false },
    release: { type: 'boolean', default: false },
    sidecar: { type: 'string' },
  },
});
if (values.unsigned === values.release) {
  console.error('Pass exactly one of --unsigned or --release.');
  process.exit(2);
}
// A missing release credential fails here, not after a ten-minute build.
const release = values.release ? releaseEnv(process.env) : undefined;
if (release !== undefined && release.feedUrl !== DEFAULT_FEED_URL) {
  console.error(`WARNING: feed override ${release.feedUrl}; desktop:publish will refuse this build.`);
}

const step = (name: string): void => console.error(`\n==> ${name}`);

step('1. verify tools');
const tools = ['cargo', 'codesign', 'vtool', 'lipo', 'ditto', 'tar', 'plutil', 'xcrun'];
if (release !== undefined) tools.push('hdiutil', 'spctl', 'syspolicy_check');
for (const tool of tools) {
  if (Bun.which(tool) === null) throw new Error(`missing tool: ${tool}`);
}
for (const tool of ['actool', ...(release === undefined ? [] : ['notarytool', 'stapler'])]) {
  if ((await $`xcrun --find ${tool}`.nothrow().quiet()).exitCode !== 0) throw new Error(`missing tool: xcrun ${tool}`);
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
// The Icon Composer document needs Xcode 26's actool. It writes Assets.car (the Liquid Glass icon,
// macOS 26+) and AppIcon.icns (earlier macOS), named after the document.
const iconSource = join(out, 'icon', 'AppIcon.icon');
rmSync(dirname(iconSource), { recursive: true, force: true });
cpSync(join(root, 'packages/brand/src/app-icon.icon'), iconSource, { recursive: true });
await $`xcrun actool ${iconSource} --compile ${join(app, 'Contents/Resources')} --app-icon AppIcon --platform macosx --target-device mac --minimum-deployment-target ${MINIMUM_MACOS} --output-partial-info-plist ${join(dirname(iconSource), 'partial.plist')}`.quiet();
// An older actool skips a `.icon` it cannot read without failing.
for (const file of ['Assets.car', 'AppIcon.icns']) {
  if (!existsSync(join(app, 'Contents/Resources', file))) throw new Error(`actool wrote no ${file}: needs Xcode 26`);
}
const devPublicEdKey = process.env['SPARKLE_PUBLIC_ED_KEY'];
const sparkleKeys =
  release !== undefined
    ? { feedUrl: release.feedUrl, publicEdKey: release.publicEdKey }
    : devPublicEdKey === undefined || devPublicEdKey === ''
      ? undefined
      : { feedUrl: process.env['SPARKLE_FEED_URL'] ?? DEFAULT_FEED_URL, publicEdKey: devPublicEdKey };
await Bun.write(
  join(app, 'Contents/Info.plist'),
  renderInfoPlist({ version, ...(sparkleKeys === undefined ? {} : { sparkle: sparkleKeys }) }),
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

const verifySigned = async (): Promise<void> => {
  await $`codesign --verify --deep --strict --verbose=2 ${app}`;
  await hostRuns('after signing');
  // The hardened sidecar must still serve, and still JIT.
  await runtimeSmoke(app, version, { jit: true });
};

if (release === undefined) {
  step('8. ad-hoc hardened signature (inside-out, Sparkle 2.10.0 order)');
  await signApp(app, { kind: 'adhoc' }, entitlements);
  await verifySigned();
  console.error(`\n${app}`);
} else {
  step('8. Developer ID signature (inside-out, Sparkle 2.10.0 order)');
  await signApp(app, { kind: 'developer-id', identity: release.identity }, entitlements);
  await verifySigned();

  step('9. notarize and staple the .app');
  const zip = join(out, 'notarize.zip');
  await $`ditto -c -k --keepParent ${app} ${zip}`;
  await notarize(zip, release.notaryAuth);
  rmSync(zip);
  await $`xcrun stapler staple ${app}`;
  await $`syspolicy_check distribution ${app}`;
  await $`spctl --assess --type execute --verbose=4 ${app}`;

  step('10. build, sign, notarize and staple the .dmg');
  const dmg = join(out, dmgName(version));
  await buildDmg(app, dmg);
  await $`codesign -s ${release.identity} --timestamp ${dmg}`;
  await notarize(dmg, release.notaryAuth);
  await $`xcrun stapler staple ${dmg}`;
  await $`spctl --assess --type open --context context:primary-signature --verbose=4 ${dmg}`;
  await $`xcrun stapler validate ${app}`;
  await $`xcrun stapler validate ${dmg}`;
  console.error(`\n${dmg}`);
}
