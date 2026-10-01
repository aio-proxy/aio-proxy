import { $ } from 'bun';

export type NotarySubmission = { readonly id: string; readonly status: string };

/**
 * `notarytool submit --wait --output-format json` ends with one JSON object, compact or pretty-printed
 * over several lines, after any progress lines. Its exit code alone is not trusted: only an "Accepted"
 * status passes.
 */
export function parseSubmission(stdout: string): NotarySubmission {
  const lines = stdout.split('\n');
  let parsed: unknown;
  // The result starts on the last line that opens an object and runs to the end of the output.
  for (let start = lines.length - 1; start >= 0 && parsed === undefined; start--) {
    if (!lines[start]!.trimStart().startsWith('{')) continue;
    try {
      parsed = JSON.parse(lines.slice(start).join('\n'));
    } catch {}
  }
  if (parsed === undefined) {
    throw new Error(`notarytool printed no JSON result: ${stdout.trim().slice(0, 300)}`);
  }
  const { id, status } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (typeof id !== 'string' || typeof status !== 'string') {
    throw new Error(`notarytool result has no id or status: ${JSON.stringify(parsed).slice(0, 300)}`);
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
