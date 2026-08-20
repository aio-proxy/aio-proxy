import type { UpgradeTarget } from './constants';
import {
  AgentPostUpgradeItemResultsSchema,
  type AgentPostUpgradeItemResult,
  type AgentPostUpgradePayload,
} from './post-upgrade-agents';

const CHILD_TIMEOUT_MS = 30_000;

type PipedChild = {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number | NodeJS.Signals) => void;
};

async function collectChild(
  child: PipedChild,
  timeoutMs: number,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {}
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`aio-proxy child timed out after ${timeoutMs}ms`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveNewAgentBinary(target: UpgradeTarget, installedVersion: string): Promise<string> {
  const binary = target.method === 'binary' ? target.path : Bun.which('aio-proxy', { PATH: process.env.PATH ?? '' });
  if (binary === null) throw new Error('upgraded aio-proxy is not on PATH');
  const checked = await collectChild(
    Bun.spawn([binary, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    CHILD_TIMEOUT_MS,
  );
  if (checked.exitCode !== 0) {
    throw new Error(`upgraded aio-proxy --version exited ${checked.exitCode}: ${checked.stderr.trim()}`);
  }
  const actualVersion = checked.stdout.trim();
  try {
    Bun.semver.order(actualVersion, installedVersion);
  } catch {
    throw new Error(`upgraded aio-proxy returned invalid version: ${actualVersion}`);
  }
  if (actualVersion !== installedVersion) {
    throw new Error(`upgraded aio-proxy version mismatch: expected ${installedVersion}, got ${actualVersion}`);
  }
  return binary;
}

export async function invokeAgentPostUpgrade(
  binary: string,
  payload: AgentPostUpgradePayload,
  options: { readonly timeoutMs?: number } = {},
): Promise<readonly AgentPostUpgradeItemResult[]> {
  const child = Bun.spawn([binary, '__agent-post-upgrade'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {}
    throw error;
  }
  const result = await collectChild(child, options.timeoutMs ?? CHILD_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error(`aio-proxy __agent-post-upgrade exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    throw new Error('aio-proxy __agent-post-upgrade returned malformed JSON');
  }
  return AgentPostUpgradeItemResultsSchema.parse(decoded);
}
