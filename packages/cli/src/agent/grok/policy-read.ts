import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import type { GrokDeadline, GrokPolicySource, GrokVisiblePolicy } from './types';

const UNVERIFIABLE = 'Grok visible policy unverifiable';
const ETC_MANAGED = '/etc/grok/managed_config.toml';
const ETC_REQUIREMENTS = '/etc/grok/requirements.toml';
const DEFAULT_BUDGET_MS = 3_000;
const MAX_POLICY_BYTES = 1_048_576;
const MDM_DOMAIN = 'ai.x.grok';

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

const remainingMs = (budget?: GrokDeadline): number =>
  budget === undefined ? DEFAULT_BUDGET_MS : Math.max(0, budget.deadline - Date.now());

const parsePolicyText = (text: string, kind: GrokPolicySource['kind']): void => {
  if (Buffer.byteLength(text) > MAX_POLICY_BYTES) throw new Error(UNVERIFIABLE);
  try {
    if (kind === 'json') {
      JSON.parse(text);
      return;
    }
    Bun.TOML.parse(text);
  } catch {
    throw new Error(UNVERIFIABLE);
  }
};

const abortWhen = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    const fail = (): void => {
      reject(new Error(UNVERIFIABLE));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });

const readBoundedText = async (
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  budget?: GrokDeadline,
): Promise<string> => {
  if (size > MAX_POLICY_BYTES) throw new Error(UNVERIFIABLE);
  const timeoutMs = remainingMs(budget);
  if (timeoutMs === 0) throw new Error(UNVERIFIABLE);
  budget?.signal.throwIfAborted();
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(budget === undefined ? [] : [budget.signal])]);
  const text = await Promise.race([handle.readFile('utf8'), abortWhen(signal)]);
  if (Buffer.byteLength(text) > MAX_POLICY_BYTES) throw new Error(UNVERIFIABLE);
  return text;
};

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const assertSafePolicyFile = (stats: Stats): void => {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(UNVERIFIABLE);
  }
};

const readExistingFile = async (
  path: string,
  kind: GrokPolicySource['kind'],
  budget?: GrokDeadline,
): Promise<GrokPolicySource> => {
  let link: Stats;
  try {
    link = await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw error;
    throw new Error(UNVERIFIABLE);
  }
  assertSafePolicyFile(link);
  let handle;
  try {
    // FIFOs and other non-regular paths must not block past the helper budget.
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw error;
    throw new Error(UNVERIFIABLE);
  }
  try {
    const file = await handle.stat();
    if (file.dev !== link.dev || file.ino !== link.ino) throw new Error(UNVERIFIABLE);
    assertSafePolicyFile(file);
    const text = await readBoundedText(handle, file.size, budget);
    parsePolicyText(text, kind);
    return { path, text, kind };
  } catch (error) {
    if (error instanceof Error && error.message === UNVERIFIABLE) throw error;
    throw new Error(UNVERIFIABLE);
  } finally {
    await handle.close();
  }
};

const readOptionalFile = async (
  path: string,
  kind: GrokPolicySource['kind'],
  budget?: GrokDeadline,
): Promise<GrokPolicySource | undefined> => {
  try {
    return await readExistingFile(path, kind, budget);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error instanceof Error && error.message === UNVERIFIABLE ? error : new Error(UNVERIFIABLE);
  }
};

const isMissingDomain = (stderr: string): boolean =>
  /does not exist/iu.test(stderr) || /not found/iu.test(stderr) || /domain.*not exist/iu.test(stderr);

const captureTimed = async (
  command: readonly [string, ...string[]],
  stdin: string | undefined,
  budget?: GrokDeadline,
): Promise<{ readonly stdout: string } | 'absent'> => {
  const [exe] = command;
  if (Bun.which(exe) === null) return 'absent';
  const timeoutMs = remainingMs(budget);
  if (timeoutMs === 0) throw new Error(UNVERIFIABLE);
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(budget === undefined ? [] : [budget.signal])]);
  const proc = Bun.spawn(command, {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });
  try {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code === 0) return { stdout };
    if (isMissingDomain(stderr)) return 'absent';
    throw new Error(UNVERIFIABLE);
  } catch (error) {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    await proc.exited.catch(() => undefined);
    if (error instanceof Error && error.message === UNVERIFIABLE) throw error;
    throw new Error(UNVERIFIABLE);
  }
};

const readMacOsMdm = async (budget?: GrokDeadline): Promise<GrokPolicySource | undefined> => {
  if (process.platform !== 'darwin') return undefined;
  const exported = await captureTimed(['defaults', 'export', MDM_DOMAIN, '-'], undefined, budget);
  if (exported === 'absent') return undefined;
  const converted = await captureTimed(['plutil', '-convert', 'json', '-o', '-', '-'], exported.stdout, budget);
  if (converted === 'absent') throw new Error(UNVERIFIABLE);
  parsePolicyText(converted.stdout, 'json');
  return { path: MDM_DOMAIN, text: converted.stdout, kind: 'json', role: 'requirements' };
};

const overlayKind = (path: string): GrokPolicySource['kind'] => (path.endsWith('.json') ? 'json' : 'toml');

export async function readGrokPolicy(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  budget?: GrokDeadline,
): Promise<GrokVisiblePolicy> {
  budget?.signal.throwIfAborted();
  const sources: GrokPolicySource[] = [];
  const files: readonly { readonly path: string; readonly kind: GrokPolicySource['kind'] }[] = [
    { path: ETC_MANAGED, kind: 'toml' },
    { path: join(root, 'managed_config.toml'), kind: 'toml' },
  ];
  for (const file of files) {
    budget?.signal.throwIfAborted();
    const source = await readOptionalFile(file.path, file.kind, budget);
    if (source !== undefined) sources.push({ ...source, role: 'managed' });
  }

  const inline = env['GROK_CONFIG'];
  const overlayPath = env['GROK_CONFIG_PATH'];
  if (inline !== undefined && inline !== '') {
    parsePolicyText(inline, 'json');
    sources.push({ path: 'GROK_CONFIG', text: inline, kind: 'json', role: 'overlay' });
  } else if (overlayPath !== undefined && overlayPath !== '') {
    budget?.signal.throwIfAborted();
    const source = await readOptionalFile(overlayPath, overlayKind(overlayPath), budget);
    if (source !== undefined) sources.push({ ...source, role: 'overlay' });
  }

  for (const path of [join(root, 'requirements.toml'), ETC_REQUIREMENTS]) {
    budget?.signal.throwIfAborted();
    const source = await readOptionalFile(path, 'toml', budget);
    if (source !== undefined) sources.push({ ...source, role: 'requirements' });
  }
  budget?.signal.throwIfAborted();
  const mdm = await readMacOsMdm(budget);
  if (mdm !== undefined) sources.push(mdm);
  return { env, sources };
}
