import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');
const workflowPath = join(import.meta.dir, '..', '.github', 'workflows', 'release.yml');

async function lockHash(): Promise<string> {
  return createHash('sha256')
    .update(await readFile(join(repositoryRoot, 'bun.lock')))
    .digest('hex');
}

test('keeps the signed CloudKit manifest until the Changesets publish step', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const publishStep = workflow.indexOf('- name: Changesets — maintain Version PR or publish');
  const cleanupStep = workflow.lastIndexOf('- name: Clean CloudKit release artifacts');
  const manifestRemoval = workflow.indexOf(
    '"$RUNNER_TEMP/AIOProxyCloudKit-${{ steps.cloudkit-release.outputs.version }}.manifest.json"',
    cleanupStep,
  );

  expect(publishStep).toBeGreaterThan(-1);
  expect(cleanupStep).toBeGreaterThan(publishStep);
  expect(manifestRemoval).toBeGreaterThan(cleanupStep);
});

test('destroys every CloudKit signing secret before Changesets runs publish code', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const signStep = workflow.indexOf('- name: Build and sign CloudKit native artifact');
  const destroyStep = workflow.indexOf('- name: Destroy CloudKit signing material');
  const publishStep = workflow.indexOf('- name: Changesets — maintain Version PR or publish');
  const destroySection = workflow.slice(destroyStep, publishStep);

  expect(destroyStep).toBeGreaterThan(signStep);
  expect(publishStep).toBeGreaterThan(destroyStep);
  // Runs even when signing failed midway, so a partial write cannot outlive the step.
  expect(destroySection).toContain("if: always() && steps.cloudkit-release.outputs.publishable == 'true'");
  expect(destroySection).toContain('security delete-keychain "$RUNNER_TEMP/aio-cloudkit-signing.keychain-db"');
  // Every secret the signing step writes to RUNNER_TEMP must be named here.
  for (const [, secret] of workflow
    .slice(signStep, destroyStep)
    .matchAll(/"\$RUNNER_TEMP\/(aio-cloudkit-signing\.[\w.-]+|aio-cloudkit-notary-key\.p8)"/gu)) {
    expect(destroySection).toContain(`"$RUNNER_TEMP/${secret}"`);
  }
});

test('uses a headless certificate-password file path without password argv', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  expect(workflow).toContain(
    'openssl pkcs12 -in "$certificate" -passin file:"$certificate_password" -nodes -out "$unlocked_certificate"',
  );
  expect(workflow).toContain('security import "$unlocked_certificate" -k "$keychain" -f pem');
  expect(workflow).not.toMatch(/security import[^\n]*\s-P(?:\s|$)/u);
  expect(workflow).not.toContain('< "$certificate_password"');
});

test('creates the notarytool profile in the ephemeral signing keychain', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  expect(workflow).toContain('APPLE_CLOUDKIT_CONTAINER_ID: ${{ vars.APPLE_CLOUDKIT_CONTAINER_ID }}');
  expect(workflow).toContain('APPLE_NOTARY_PROFILE: ${{ vars.APPLE_NOTARY_PROFILE }}');
  expect(workflow).toContain('APPLE_NOTARY_KEY_BASE64: ${{ secrets.APPLE_NOTARY_KEY_BASE64 }}');
  expect(workflow).toContain('APPLE_NOTARY_KEY_ID: ${{ secrets.APPLE_NOTARY_KEY_ID }}');
  expect(workflow).toContain('APPLE_NOTARY_ISSUER_ID: ${{ secrets.APPLE_NOTARY_ISSUER_ID }}');
  expect(workflow).toContain('xcrun notarytool store-credentials "$APPLE_NOTARY_PROFILE"');
  expect(workflow).toContain('--keychain "$keychain"');
  expect(workflow).toContain('"$RUNNER_TEMP/aio-cloudkit-notary-key.p8"');
  expect(workflow).toContain('export APPLE_PROFILE_PATH="$profile"');
});

test('installs bun from a pinned commit, never a movable tag', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  // Every job here hands a secret to the `bun` this action installs — the Developer ID and
  // notary key when releasing CloudKit, the tap token when notifying Homebrew. A retargeted
  // tag would swap that binary for one that reads them.
  const references = [...workflow.matchAll(/uses: oven-sh\/setup-bun@(\S+)/gu)].map(([, reference]) => reference);

  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) expect(reference).toMatch(/^[0-9a-f]{40}$/u);
});

test('dry-run restores bun.lock and never invokes npm publish', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'aio-release-dry-run-'));
  const fakeBin = join(temporaryDirectory, 'bin');
  const npmMarker = join(temporaryDirectory, 'npm-invoked');
  const fakeNpm = join(fakeBin, 'npm');
  await mkdir(fakeBin);
  await writeFile(fakeNpm, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$RELEASE_TEST_NPM_MARKER"\nexit 97\n');
  await chmod(fakeNpm, 0o755);

  const before = await lockHash();
  try {
    const child = Bun.spawn([process.execPath, join(repositoryRoot, 'scripts', 'release.ts'), '--dry-run'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
        RELEASE_TEST_NPM_MARKER: npmMarker,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('[dry-run] Would publish');
    expect(`${stdout}\n${stderr}`).not.toContain('npm publish');
    expect(await lockHash()).toBe(before);
    expect(await Bun.file(npmMarker).exists()).toBe(false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}, 120_000);
