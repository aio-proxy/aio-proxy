import { mkdtempSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'bun';

export const APP_NAME = 'AIO Proxy.app';

export const dmgName = (version: string): string => `aio-proxy-${version}-arm64.dmg`;

/** A drag-to-install image: the stapled app beside a link to /Applications. */
export async function buildDmg(app: string, dmg: string): Promise<void> {
  const stage = mkdtempSync(join(tmpdir(), 'aio-proxy-dmg-'));
  try {
    await $`ditto ${app} ${join(stage, APP_NAME)}`;
    symlinkSync('/Applications', join(stage, 'Applications'));
    rmSync(dmg, { force: true });
    await $`hdiutil create -volname ${'AIO Proxy'} -srcfolder ${stage} -format UDZO ${dmg}`;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export type MountedApp = { readonly version: string; readonly feedUrl: string; readonly publicEdKey: string };

/**
 * The Gatekeeper checks a downloaded copy meets: the signed, notarized .dmg, then the app inside it,
 * mounted read-only. Returns the app's version and update keys for the feed checks.
 */
export async function verifyDmg(dmg: string): Promise<MountedApp> {
  await $`spctl --assess --type open --context context:primary-signature --verbose=4 ${dmg}`;
  await $`xcrun stapler validate ${dmg}`;
  const mount = mkdtempSync(join(tmpdir(), 'aio-proxy-dmg-mount-'));
  await $`hdiutil attach -nobrowse -readonly -noautoopen -mountpoint ${mount} ${dmg}`.quiet();
  try {
    const app = join(mount, APP_NAME);
    await $`codesign --verify --deep --strict --verbose=2 ${app}`;
    await $`spctl --assess --type execute --verbose=4 ${app}`;
    await $`xcrun stapler validate ${app}`;
    const plist = join(app, 'Contents/Info.plist');
    const read = async (key: string): Promise<string> =>
      (await $`plutil -extract ${key} raw -o - ${plist}`.text()).trim();
    return {
      version: await read('CFBundleShortVersionString'),
      feedUrl: await read('SUFeedURL'),
      publicEdKey: await read('SUPublicEDKey'),
    };
  } finally {
    await $`hdiutil detach ${mount}`.nothrow().quiet();
    // Only the empty mount point: never recurse into a volume that failed to detach.
    try {
      rmdirSync(mount);
    } catch {}
  }
}
