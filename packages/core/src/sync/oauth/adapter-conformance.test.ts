import { expect, test } from 'bun:test';

import { evaluateOAuthEvidence } from './adapter-conformance';

test('copied credential success alone does not verify a rotating adapter', () => {
  expect(
    evaluateOAuthEvidence({
      plugin: '@example/oauth',
      pluginVersion: '1.0.0',
      capability: 'oauth',
      formatVersion: 1,
      testedAt: '2026-09-08T00:00:00Z',
      upstream: 'fixture',
      copiedUse: 'pass',
      rotation: 'blocked',
      uncertainRecovery: 'blocked',
      deviceBinding: 'blocked',
      loginEffects: 'blocked',
      independentDetach: 'blocked',
    }),
  ).toEqual({ multiDevice: false, independentDetach: false });
});

test('non-rotating adapters still require every other multi-device check', () => {
  expect(
    evaluateOAuthEvidence({
      plugin: '@example/oauth',
      pluginVersion: '1.0.0',
      capability: 'oauth',
      formatVersion: 1,
      testedAt: '2026-09-08T00:00:00Z',
      upstream: 'fixture',
      copiedUse: 'pass',
      rotation: 'not-applicable',
      uncertainRecovery: 'pass',
      deviceBinding: 'pass',
      loginEffects: 'pass',
      independentDetach: 'pass',
    }),
  ).toEqual({ multiDevice: true, independentDetach: true });
});

test('independent detachment cannot be claimed when multi-device evidence is incomplete', () => {
  expect(
    evaluateOAuthEvidence({
      plugin: '@example/oauth',
      pluginVersion: '1.0.0',
      capability: 'oauth',
      formatVersion: 1,
      testedAt: '2026-09-08T00:00:00Z',
      upstream: 'fixture',
      copiedUse: 'pass',
      rotation: 'pass',
      uncertainRecovery: 'pass',
      deviceBinding: 'pass',
      loginEffects: 'pass',
      independentDetach: 'blocked',
    }),
  ).toEqual({ multiDevice: true, independentDetach: false });
});
