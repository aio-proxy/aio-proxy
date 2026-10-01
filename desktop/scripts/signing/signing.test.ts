import { describe, expect, test } from 'bun:test';

import { signSteps } from './signing';

const app = '/b/AIO Proxy.app';
const entitlements = '/e';
const relative = (path: string): string => path.slice(app.length) || '.';
const developerId = { kind: 'developer-id', identity: 'Developer ID Application: Team (TEAMID)' } as const;

describe('signSteps', () => {
  test('signs inside-out in Sparkle 2.10.0 order, one path per step, never --deep', () => {
    const steps = signSteps(app, developerId, entitlements);
    expect(steps.map((step) => relative(step.path))).toEqual([
      '/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc',
      '/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc',
      '/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate',
      '/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app',
      '/Contents/Frameworks/Sparkle.framework',
      '/Contents/MacOS/aio-proxy',
      '/Contents/MacOS/aio-proxy-desktop',
      '.',
    ]);
    for (const step of steps) {
      expect(step.args).not.toContain('--deep');
      expect(step.args.at(-1)).toBe(step.path);
    }
    expect(steps[1]?.args).toContain('--preserve-metadata=entitlements');
  });

  test('Developer ID: every step is timestamped and only the sidecar carries entitlements', () => {
    const steps = signSteps(app, developerId, entitlements);
    for (const step of steps) {
      expect(step.args).toEqual(expect.arrayContaining(['-s', developerId.identity, '-o', 'runtime', '--timestamp']));
    }
    const entitled = steps.filter((step) => step.args.includes('--entitlements'));
    expect(entitled.map((step) => relative(step.path))).toEqual(['/Contents/MacOS/aio-proxy']);
    expect(entitled[0]?.args).toContain('/e/aio-proxy.plist');
  });

  test('ad-hoc: no timestamp, and the host gets disable-library-validation on its own step and the .app step', () => {
    const steps = signSteps(app, { kind: 'adhoc' }, entitlements);
    for (const step of steps) expect(step.args).not.toContain('--timestamp');
    const hostEntitled = steps.filter((step) => step.args.includes('/e/adhoc-host.plist'));
    expect(hostEntitled.map((step) => relative(step.path))).toEqual(['/Contents/MacOS/aio-proxy-desktop', '.']);
  });
});
