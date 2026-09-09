export interface OAuthSyncEvidence {
  readonly plugin: string;
  readonly pluginVersion: string;
  readonly capability: string;
  readonly formatVersion: number;
  readonly testedAt: string;
  readonly upstream: string;
  readonly copiedUse: 'pass' | 'fail' | 'blocked';
  readonly rotation: 'pass' | 'fail' | 'not-applicable' | 'blocked';
  readonly uncertainRecovery: 'pass' | 'fail' | 'blocked';
  readonly deviceBinding: 'pass' | 'fail' | 'blocked';
  readonly loginEffects: 'pass' | 'fail' | 'blocked';
  readonly independentDetach: 'pass' | 'fail' | 'blocked';
}

export function evaluateOAuthEvidence(evidence: OAuthSyncEvidence): {
  readonly multiDevice: boolean;
  readonly independentDetach: boolean;
} {
  const multiDevice =
    evidence.copiedUse === 'pass' &&
    (evidence.rotation === 'pass' || evidence.rotation === 'not-applicable') &&
    evidence.uncertainRecovery === 'pass' &&
    evidence.deviceBinding === 'pass' &&
    evidence.loginEffects === 'pass';

  return {
    multiDevice,
    independentDetach: multiDevice && evidence.independentDetach === 'pass',
  };
}
