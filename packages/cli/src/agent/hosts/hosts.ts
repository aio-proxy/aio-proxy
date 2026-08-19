import { isAbsolute, join } from 'node:path';

import type { AgentTarget } from '@aio-proxy/types';

export type AgentHostDeps = {
  readonly which: (name: string) => string | null;
  readonly capture: (command: readonly [string, ...string[]]) => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
};
export type AgentHost = {
  readonly target: AgentTarget;
  readonly detected: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly minimumVersion: string;
  readonly support: 'supported' | 'unsupported' | 'unknown';
};
export type AgentLocation = {
  readonly target: AgentTarget;
  readonly hostRoot: string;
  readonly managedDir: string;
  readonly adjacentEntry?: string;
};

const hostCommand = {
  opencode: { executable: 'opencode', versionArgs: ['--version'], floor: '1.17.10' },
  pi: { executable: 'pi', versionArgs: ['--version'], floor: '0.84.2' },
  omp: { executable: 'omp', versionArgs: ['--version'], floor: '17.3.7' },
} as const;

const parseVersion = (target: AgentTarget, output: string): string | undefined => {
  const value = output.trim();
  const candidate = value.startsWith(`${target}/`) ? value.slice(target.length + 1) : value;
  try {
    Bun.semver.order(candidate, candidate);
    return candidate;
  } catch {
    return undefined;
  }
};

export async function detectAgentHost(target: AgentTarget, deps: AgentHostDeps): Promise<AgentHost> {
  const command = hostCommand[target];
  const executable = deps.which(command.executable);
  if (executable === null) {
    return { target, detected: false, minimumVersion: command.floor, support: 'unknown' };
  }
  let version: string | undefined;
  try {
    version = parseVersion(target, await deps.capture([executable, ...command.versionArgs]));
  } catch {
    return { target, detected: true, executable, minimumVersion: command.floor, support: 'unknown' };
  }
  if (version === undefined) {
    return { target, detected: true, executable, minimumVersion: command.floor, support: 'unknown' };
  }
  return {
    target,
    detected: true,
    executable,
    version,
    minimumVersion: command.floor,
    support: Bun.semver.order(version, command.floor) < 0 ? 'unsupported' : 'supported',
  };
}

const requireAbsolute = (value: string, diagnostic: string): string => {
  if (!isAbsolute(value)) throw new Error(diagnostic);
  return value;
};

export async function resolveAgentLocation(target: AgentTarget, deps: AgentHostDeps): Promise<AgentLocation> {
  const command = hostCommand[target];
  const executable = deps.which(command.executable);
  if (executable === null) throw new Error(`${command.executable} is not installed`);

  if (target === 'opencode') {
    const output = await deps.capture([executable, 'debug', 'paths']);
    const config = output
      .split(/\r?\n/u)
      .map((line) => /^(\S+)\s+(.+)$/u.exec(line.trim()))
      .find((match) => match?.[1] === 'config')?.[2];
    if (config === undefined) throw new Error('opencode debug paths did not report config');
    const hostRoot = join(requireAbsolute(config, 'opencode config path is relative'), 'plugins');
    return {
      target,
      hostRoot,
      managedDir: join(hostRoot, 'aio-proxy'),
      adjacentEntry: join(hostRoot, 'aio-proxy.js'),
    };
  }

  if (target === 'pi') {
    const override = deps.env.PI_CODING_AGENT_DIR;
    const configured =
      override === undefined || override === ''
        ? join(deps.home, '.pi', 'agent')
        : override === '~'
          ? deps.home
          : override.startsWith('~/')
            ? join(deps.home, override.slice(2))
            : override;
    const agentDir = requireAbsolute(configured, 'Pi agent directory is relative');
    const hostRoot = join(agentDir, 'extensions');
    return { target, hostRoot, managedDir: join(hostRoot, 'aio-proxy') };
  }

  const agentDir = requireAbsolute(
    (await deps.capture([executable, 'config', 'path'])).trim(),
    'omp config path is empty or relative',
  );
  const hostRoot = join(agentDir, 'extensions');
  return { target, hostRoot, managedDir: join(hostRoot, 'aio-proxy') };
}
