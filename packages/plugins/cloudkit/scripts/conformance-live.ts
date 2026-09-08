import { platform, release } from 'node:os';
import { join } from 'node:path';

import { exerciseSyncBackend } from '@aio-proxy/plugin-sdk/testing';

import { connectInstalledPair, installedArtifactDigest } from './live-support';

type CaseResult = { readonly name: string; readonly status: 'pass' | 'fail' | 'blocked'; readonly errorCode?: string };
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
    artifact: { manifestSha256: (await installedArtifactDigest()) ?? 'unavailable' },
    containerId: process.env.CLOUDKIT_CONTAINER_ID === undefined ? 'unavailable' : '<configured>',
    cases,
    productionGate: cases.some((entry) => entry.status !== 'pass') ? 'blocked' : 'unverified',
    recordedAt: new Date().toISOString(),
  };
  await Bun.write(evidencePath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify({
      cases: cases.map(({ name, status, errorCode: code }) => ({ name, status, ...(code ? { errorCode: code } : {}) })),
    }),
  );
}

if (!process.argv.includes('--live')) throw new Error('Use --live for the dedicated test namespace');

const cases: CaseResult[] = [];
try {
  await exerciseSyncBackend(connectInstalledPair);
  cases.push({ name: 'installed two-process sync conformance', status: 'pass' });
} catch (error) {
  const status = process.platform === 'darwin' && process.env.CLOUDKIT_CONTAINER_ID ? 'fail' : 'blocked';
  cases.push({ name: 'installed two-process sync conformance', status, errorCode: errorCode(error) });
} finally {
  await writeEvidence(cases);
}

if (cases.some((entry) => entry.status !== 'pass')) process.exitCode = 1;
