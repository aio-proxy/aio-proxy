import { $ } from 'bun';

export type NotarySubmission = { readonly id: string; readonly status: string };

/**
 * `notarytool submit --wait --output-format json` ends with one JSON object. Its exit code alone is
 * not trusted: only an "Accepted" status passes.
 */
export function parseSubmission(stdout: string): NotarySubmission {
  const line = stdout
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.startsWith('{'))
    .at(-1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line ?? '');
  } catch {
    throw new Error(`notarytool printed no JSON result: ${stdout.trim().slice(0, 300)}`);
  }
  const { id, status } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof id !== 'string' || typeof status !== 'string') {
    throw new Error(`notarytool result has no id or status: ${line}`);
  }
  return { id, status };
}

export async function notarize(file: string, auth: readonly string[]): Promise<void> {
  const submit = await $`xcrun notarytool submit ${file} ${auth} --wait --output-format json`.nothrow().quiet();
  let submission: NotarySubmission;
  try {
    submission = parseSubmission(submit.stdout.toString());
  } catch (error) {
    throw new Error(`notarytool submit ${file} failed (exit ${submit.exitCode}): ${submit.stderr.toString().trim()}`, {
      cause: error,
    });
  }
  console.error(`notarytool: ${file} ${submission.status} (${submission.id})`);
  if (submission.status !== 'Accepted') {
    const log = await $`xcrun notarytool log ${submission.id} ${auth}`.nothrow().text();
    throw new Error(`notarization of ${file} ended "${submission.status}" (${submission.id}):\n${log}`);
  }
}
