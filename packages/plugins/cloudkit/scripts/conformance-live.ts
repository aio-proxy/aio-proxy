import { platform, release } from 'node:os';
import { join } from 'node:path';

import { exerciseSyncBackend } from '@aio-proxy/plugin-sdk/testing';

import { connectInstalledPair, installedArtifactDigest, LiveSetupError } from './live-support';

type CaseResult = { readonly name: string; readonly status: 'pass' | 'fail' | 'blocked'; readonly errorCode?: string };
const requiredGates = [
  'installed two-process sync conformance',
  'two-Mac cross-device conformance',
  'launchd service with Dashboard closed',
  'network interruption and reconnect recovery',
  'iCloud identity switch handling',
  'native/process restart pending-CAS recovery',
  'controlled quota rejection',
  'Production schema and index availability',
  'installed-path entitlement and direct access',
] as const;
const evidencePath =
  process.env.CLOUDKIT_EVIDENCE_PATH ??
  join(import.meta.dir, '..', '..', '..', '..', 'docs', 'testing', 'evidence', 'cloudkit-sync.json');

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return 'invalid-data';
}

async function osVersion(): Promise<string> {
  if (process.platform !== 'darwin') return `${platform()} ${release()}`;
  const child = Bun.spawn(['sw_vers', '-productVersion'], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return output.trim();
}

async function writeEvidence(cases: readonly CaseResult[]): Promise<void> {
  const output = {
    host: { os: process.platform, osVersion: await osVersion(), architecture: process.arch },
    artifact: { installedManifestSha256: (await installedArtifactDigest()) ?? 'unavailable' },
    containerId: process.env.CLOUDKIT_CONTAINER_ID === undefined ? 'unavailable' : '<configured>',
    cases,
    productionGate: cases.some((entry) => entry.status !== 'pass') ? 'blocked' : 'unverified',
    recordedAt: new Date().toISOString(),
  };
  await Bun.write(evidencePath, `${JSON.stringify(output, null, 2)}\n`);
  const counts = cases.reduce((result, entry) => ({ ...result, [entry.status]: result[entry.status] + 1 }), {
    pass: 0,
    fail: 0,
    blocked: 0,
  });
  const errorCodes = cases.flatMap((entry) => (entry.errorCode === undefined ? [] : [entry.errorCode]));
  console.log(JSON.stringify({ counts, errorCodes }));
}

if (!process.argv.includes('--live')) throw new Error('Use --live for the dedicated test namespace');

const cases: CaseResult[] = requiredGates.map((name) => ({ name, status: 'blocked' }));
try {
  await exerciseSyncBackend(connectInstalledPair);
  cases[0] = { name: requiredGates[0], status: 'pass' };
} catch (error) {
  cases[0] = {
    name: requiredGates[0],
    status: error instanceof LiveSetupError ? 'blocked' : 'fail',
    errorCode: errorCode(error),
  };
} finally {
  await writeEvidence(cases);
}

if (cases.some((entry) => entry.status !== 'pass')) process.exitCode = 1;
