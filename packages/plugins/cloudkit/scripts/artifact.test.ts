import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertNoSymlinkEscape,
  CLOUDKIT_SIGNING_STEPS,
  executablePathForApp,
  validateEffectiveEntitlements,
  validateManifest,
  validateProfileMetadata,
} from './artifact';

const profile = {
  TeamIdentifier: ['TEAM123'],
  Platform: ['OSX'],
  ProvisionsAllDevices: true,
  ExpirationDate: '2099-01-01T00:00:00Z',
  Entitlements: {
    'application-identifier': 'TEAM123.dev.aioproxy',
    'com.apple.developer.team-identifier': 'TEAM123',
    'com.apple.developer.icloud-container-identifiers': ['iCloud.dev.aioproxy'],
    'com.apple.developer.icloud-services': ['CloudKit'],
    'com.apple.developer.icloud-container-environment': 'Production',
  },
};

describe('CloudKit artifact gates', () => {
  test('rejects a profile from another team or container', () => {
    expect(() =>
      validateProfileMetadata(profile, {
        teamId: 'OTHER',
        containerId: 'iCloud.dev.aioproxy',
        bundleId: 'dev.aioproxy',
      }),
    ).toThrow('team');
    expect(() =>
      validateProfileMetadata(profile, { teamId: 'TEAM123', containerId: 'iCloud.other', bundleId: 'dev.aioproxy' }),
    ).toThrow('CLOUDKIT_CONTAINER_ID');
  });

  test('validates effective entitlements and preserves signing order', () => {
    const input = {
      teamId: 'TEAM123',
      containerId: 'iCloud.dev.aioproxy',
      bundleId: 'dev.aioproxy',
      environment: 'Production',
    };
    validateEffectiveEntitlements(profile.Entitlements, input);
    expect(CLOUDKIT_SIGNING_STEPS.indexOf('nested-code')).toBeLessThan(CLOUDKIT_SIGNING_STEPS.indexOf('bundle'));
    expect(CLOUDKIT_SIGNING_STEPS.indexOf('staple')).toBeLessThan(CLOUDKIT_SIGNING_STEPS.indexOf('archive-final'));
  });

  test('requires universal output and final artifact digests', () => {
    expect(() =>
      validateManifest({
        artifactVersion: '1.0.0',
        bundleIdentifier: 'dev.aioproxy',
        appRelativePath: 'a',
        executableRelativePath: 'b',
        architectures: ['arm64'],
        executableSha256: '0'.repeat(64),
      }),
    ).toThrow('universal');
    expect(() =>
      validateManifest({
        artifactVersion: '1.0.0',
        bundleIdentifier: 'dev.aioproxy',
        appRelativePath: 'a',
        executableRelativePath: 'b',
        architectures: ['arm64', 'x86_64'],
        executableSha256: 'bad',
        appSha256: '0'.repeat(64),
      }),
    ).toThrow('executable digest');
  });

  test('requires safe manifest paths and final archive binding', () => {
    const manifest = {
      artifactVersion: '1.0.0',
      bundleIdentifier: 'dev.aioproxy',
      appRelativePath: 'dist/native/AIOProxyCloudKit.app',
      executableRelativePath: 'dist/native/AIOProxyCloudKit.app/Contents/MacOS/AIOProxyCloudKit',
      architectures: ['arm64', 'x86_64'],
      executableSha256: '0'.repeat(64),
      appSha256: '1'.repeat(64),
    } as const;
    expect(() => validateManifest({ ...manifest, appRelativePath: '../outside' })).toThrow('path is unsafe');
    expect(() => validateManifest({ ...manifest, executableRelativePath: 'dist/other/AIOProxyCloudKit' })).toThrow(
      'outside the app',
    );
    expect(() => validateManifest({ ...manifest, signatureStatus: 'verified' })).toThrow('final artifact binding');
    expect(executablePathForApp(manifest, '/tmp/staged/AIOProxyCloudKit.app')).toBe(
      '/tmp/staged/AIOProxyCloudKit.app/Contents/MacOS/AIOProxyCloudKit',
    );
  });

  test('rejects a symlinked validation root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-path-'));
    const real = join(root, 'real');
    const link = join(root, 'link');
    await mkdir(real);
    await symlink(real, link, 'dir');
    await expect(assertNoSymlinkEscape(link, join(link, 'artifact'), 'test')).rejects.toThrow('symlink');
  });
});
