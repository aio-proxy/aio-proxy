import { join } from 'node:path';

import { $ } from 'bun';

export type Signer = { readonly kind: 'adhoc' } | { readonly kind: 'developer-id'; readonly identity: string };

export type SignStep = { readonly path: string; readonly args: readonly string[] };

/**
 * Inside-out codesign steps in Sparkle 2.10.0's documented order; `--deep` is never used. Only the
 * sidecar gets the committed allow-jit entitlements. An ad-hoc signature has no Team ID, so
 * hardened-runtime library validation would reject Sparkle: only an ad-hoc host gets
 * disable-library-validation, on its own step and on the .app step (which re-signs the main executable).
 */
export function signSteps(app: string, signer: Signer, entitlementsDir: string): SignStep[] {
  const framework = join(app, 'Contents/Frameworks/Sparkle.framework');
  const base =
    signer.kind === 'adhoc'
      ? ['-f', '-s', '-', '-o', 'runtime']
      : ['-f', '-s', signer.identity, '-o', 'runtime', '--timestamp'];
  const host = signer.kind === 'adhoc' ? ['--entitlements', join(entitlementsDir, 'adhoc-host.plist')] : [];
  const step = (path: string, ...extra: string[]): SignStep => ({ path, args: [...base, ...extra, path] });
  return [
    step(join(framework, 'Versions/B/XPCServices/Installer.xpc')),
    step(join(framework, 'Versions/B/XPCServices/Downloader.xpc'), '--preserve-metadata=entitlements'),
    step(join(framework, 'Versions/B/Autoupdate')),
    step(join(framework, 'Versions/B/Updater.app')),
    step(framework),
    step(join(app, 'Contents/MacOS/aio-proxy'), '--entitlements', join(entitlementsDir, 'aio-proxy.plist')),
    step(join(app, 'Contents/MacOS/aio-proxy-desktop'), ...host),
    step(app, ...host),
  ];
}

/** codesign output stays visible: a failed step's stderr is the only diagnosis CI gets. */
export async function signApp(app: string, signer: Signer, entitlementsDir: string): Promise<void> {
  for (const { args } of signSteps(app, signer, entitlementsDir)) await $`codesign ${args}`;
}
