import { describe, expect, test } from 'bun:test';

import {
  CLOUDKIT_SIGNING_STEPS,
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
});
