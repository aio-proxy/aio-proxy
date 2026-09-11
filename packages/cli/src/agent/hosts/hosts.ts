import { isAbsolute, join } from 'node:path';

import type { AgentPluginTarget, AgentTarget } from '@aio-proxy/types';

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
export type AgentPluginLocation = AgentLocation & { readonly target: AgentPluginTarget };

const GROK_FLOOR = '1.0.24';

const hostCommand = {
  opencode: { executable: 'opencode', versionArgs: ['--version'], floor: '1.17.10' },
  pi: { executable: 'pi', versionArgs: ['--version'], floor: '0.84.2' },
  omp: { executable: 'omp', versionArgs: ['--version'], floor: '17.3.7' },
} as const;

const isPluginTarget = (target: AgentTarget): target is AgentPluginTarget =>
  target === 'opencode' || target === 'pi' || target === 'omp';

const parseVersion = (target: AgentPluginTarget, output: string): string | undefined => {
  const value = output.trim();
  const candidate = value.startsWith(`${target}/`) ? value.slice(target.length + 1) : value;
  try {
    Bun.semver.order(candidate, candidate);
    return candidate;
  } catch {
    return undefined;
  }
};

const parseGrokVersion = (output: string): string | undefined => {
  const candidate = /^\s*grok\s+(\S+)/u.exec(output)?.[1];
  if (candidate === undefined) return undefined;
  try {
    Bun.semver.order(candidate, candidate);
    return candidate;
  } catch {
    return undefined;
  }
};

const classifyHost = (
  target: AgentTarget,
  executable: string,
  version: string | undefined,
  minimumVersion: string,
): AgentHost => {
  if (version === undefined) {
    return { target, detected: true, executable, minimumVersion, support: 'unknown' };
  }
  return {
    target,
    detected: true,
    executable,
    version,
    minimumVersion,
    support: Bun.semver.order(version, minimumVersion) < 0 ? 'unsupported' : 'supported',
  };
};

export async function detectAgentHost(target: AgentTarget, deps: AgentHostDeps): Promise<AgentHost> {
  if (target === 'grok') {
    const executable = deps.which('grok');
    if (executable === null) {
      return { target, detected: false, minimumVersion: GROK_FLOOR, support: 'unknown' };
    }
    try {
      return classifyHost(
        target,
        executable,
        parseGrokVersion(await deps.capture([executable, '--version'])),
        GROK_FLOOR,
      );
    } catch {
      return { target, detected: true, executable, minimumVersion: GROK_FLOOR, support: 'unknown' };
    }
  }
  if (!isPluginTarget(target)) throw new Error(`${target} is not a plugin host`);
  const command = hostCommand[target];
  const executable = deps.which(command.executable);
  if (executable === null) {
    return { target, detected: false, minimumVersion: command.floor, support: 'unknown' };
  }
  try {
    return classifyHost(
      target,
      executable,
      parseVersion(target, await deps.capture([executable, ...command.versionArgs])),
      command.floor,
    );
  } catch {
    return { target, detected: true, executable, minimumVersion: command.floor, support: 'unknown' };
  }
}

const requireAbsolute = (value: string, diagnostic: string): string => {
  if (!isAbsolute(value)) throw new Error(diagnostic);
  return value;
};

export function resolveGrokRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env['GROK_HOME'];
  const configured =
    override === undefined || override === ''
      ? join(home, '.grok')
      : override.startsWith('~/')
        ? join(home, override.slice(2))
        : override;
  return requireAbsolute(configured, 'Grok home is not absolute');
}

export async function resolveAgentLocation(
  target: AgentPluginTarget,
  deps: AgentHostDeps,
): Promise<AgentPluginLocation>;
export async function resolveAgentLocation(target: AgentTarget, deps: AgentHostDeps): Promise<AgentLocation>;
export async function resolveAgentLocation(target: AgentTarget, deps: AgentHostDeps): Promise<AgentLocation> {
  if (target === 'grok') {
    const hostRoot = resolveGrokRoot(deps.env, deps.home);
    return { target, hostRoot, managedDir: join(hostRoot, 'aio-proxy') };
  }
  if (!isPluginTarget(target)) throw new Error(`${target} is not a plugin host`);
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
    const override = deps.env['PI_CODING_AGENT_DIR'];
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
