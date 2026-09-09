import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const workflowPath = join(import.meta.dir, '..', '.github', 'workflows', 'release.yml');

test('keeps the signed CloudKit manifest until the Changesets publish step', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const publishStep = workflow.indexOf('- name: Changesets — maintain Version PR or publish');
  const cleanupStep = workflow.lastIndexOf('- name: Clean CloudKit signing keychain');
  const manifestRemoval = workflow.indexOf(
    '"$RUNNER_TEMP/AIOProxyCloudKit-${{ steps.cloudkit-release.outputs.version }}.manifest.json"',
    cleanupStep,
  );

  expect(publishStep).toBeGreaterThan(-1);
  expect(cleanupStep).toBeGreaterThan(publishStep);
  expect(manifestRemoval).toBeGreaterThan(cleanupStep);
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
