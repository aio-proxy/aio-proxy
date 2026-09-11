import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { GrokDeadline, GrokPolicySource, GrokVisiblePolicy } from './types';

const UNVERIFIABLE = 'Grok visible policy unverifiable';
const ETC_MANAGED = '/etc/grok/managed_config.toml';
const ETC_REQUIREMENTS = '/etc/grok/requirements.toml';
const DEFAULT_BUDGET_MS = 3_000;
const MDM_DOMAIN = 'ai.x.grok';

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

const remainingMs = (budget?: GrokDeadline): number =>
  budget === undefined ? DEFAULT_BUDGET_MS : Math.max(0, budget.deadline - Date.now());

const parsePolicyText = (text: string, kind: GrokPolicySource['kind']): void => {
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

const readExistingFile = async (path: string, kind: GrokPolicySource['kind']): Promise<GrokPolicySource> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw error;
    throw new Error(UNVERIFIABLE);
  }
  try {
    const text = await handle.readFile('utf8');
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
): Promise<GrokPolicySource | undefined> => {
  try {
    return await readExistingFile(path, kind);
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
  return { path: MDM_DOMAIN, text: converted.stdout, kind: 'json' };
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
    const source = await readOptionalFile(file.path, file.kind);
    if (source !== undefined) sources.push(source);
  }

  const inline = env['GROK_CONFIG'];
  const overlayPath = env['GROK_CONFIG_PATH'];
  if (inline !== undefined && inline !== '') {
    parsePolicyText(inline, 'json');
    sources.push({ path: 'GROK_CONFIG', text: inline, kind: 'json' });
  } else if (overlayPath !== undefined && overlayPath !== '') {
    budget?.signal.throwIfAborted();
    const source = await readOptionalFile(overlayPath, overlayKind(overlayPath));
    if (source !== undefined) sources.push(source);
  }

  for (const path of [join(root, 'requirements.toml'), ETC_REQUIREMENTS]) {
    budget?.signal.throwIfAborted();
    const source = await readOptionalFile(path, 'toml');
    if (source !== undefined) sources.push(source);
  }
  budget?.signal.throwIfAborted();
  const mdm = await readMacOsMdm(budget);
  if (mdm !== undefined) sources.push(mdm);
  return { env, sources };
}
