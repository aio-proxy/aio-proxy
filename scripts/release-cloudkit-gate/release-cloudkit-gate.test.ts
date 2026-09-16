import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cloudKitReleaseGatePassed } from './release-cloudkit-gate';

async function gateFor(evidence: string | undefined): Promise<boolean> {
  const path = join(mkdtempSync(join(tmpdir(), 'aio-proxy-cloudkit-gate-')), 'evidence.json');
  if (evidence !== undefined) await Bun.write(path, evidence);
  process.env['APPLE_CLOUDKIT_EVIDENCE_PATH'] = path;
  try {
    return await cloudKitReleaseGatePassed();
  } finally {
    delete process.env['APPLE_CLOUDKIT_EVIDENCE_PATH'];
  }
}

// The gate decides whether an unverified signed native bundle reaches npm, so every answer other than
// a recorded pass has to withhold it. `unverified` is the value conformance-live.ts writes when the
// automated cases all pass, and it is the one that must still not publish: the launchd-service and
// Production-container runs it cannot perform are exactly what the gate exists to require.
test('publishes CloudKit only for evidence that records a passed production gate', async () => {
  expect(await gateFor('{"productionGate":"passed"}')).toBe(true);
  expect(await gateFor('{"productionGate":"unverified"}')).toBe(false);
  expect(await gateFor('{"productionGate":"blocked"}')).toBe(false);
  expect(await gateFor('{}')).toBe(false);
  expect(await gateFor('not json')).toBe(false);
  expect(await gateFor(undefined)).toBe(false);
});
