import { access, lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize } from 'node:path';

export type CommandLocationOptions = {
  readonly pathEnv?: string;
  readonly candidates?: readonly string[];
  readonly spawn?: typeof Bun.spawn;
};

const candidateNames = new Set(['aiop', 'aio-proxy']);

function isAllowedName(path: string): boolean {
  const name = basename(path);
  return candidateNames.has(name) && !name.endsWith('.js') && !name.endsWith('.ts');
}

function isDevelopmentPath(path: string): boolean {
  const normalized = normalize(path);
  return (
    normalized.endsWith('/bun') ||
    normalized.endsWith('/node') ||
    normalized.includes('/node_modules/.bin/') ||
    normalized.endsWith('.js') ||
    normalized.endsWith('.ts') ||
    normalized.includes('/src/') ||
    normalized.includes('/scripts/')
  );
}

async function runVersion(path: string, spawn: typeof Bun.spawn): Promise<boolean> {
  try {
    const child = spawn([path, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const status = await child.exited;
    return status === 0 && /(?:aiop|aio-proxy)(?:-cli)?\s+\d+\.\d+\.\d+/iu.test(output);
  } catch {
    return false;
  }
}

function pathCandidates(options: CommandLocationOptions): string[] {
  if (options.candidates !== undefined) return [...options.candidates];
  const pathEnv = options.pathEnv ?? process.env['PATH'] ?? '';
  return pathEnv
    .split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .flatMap((dir) => [...candidateNames].map((name) => join(dir, name)));
}

export async function resolveCodexAuthCommand(options: CommandLocationOptions = {}): Promise<string> {
  const spawn = options.spawn ?? Bun.spawn;
  for (const candidate of pathCandidates(options)) {
    if (!isAbsolute(candidate) || !isAllowedName(candidate) || isDevelopmentPath(candidate)) continue;
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
      await access(candidate);
      const target = await realpath(candidate);
      if (isDevelopmentPath(target) || !isAllowedName(target)) continue;
      if (!(await runVersion(candidate, spawn))) continue;
      // Keep the stable launcher path. Resolving the target here would freeze a
      // versioned Homebrew/npm installation and break after an upgrade.
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('Installed aio-proxy command not found');
}

export async function assertStableCodexAuthCommand(command: string): Promise<string> {
  const normalized = normalize(command);
  if (!isAbsolute(normalized) || !isAllowedName(normalized) || isDevelopmentPath(normalized))
    throw new Error('Codex command must be an installed aiop or aio-proxy executable');
  await realpath(normalized).catch(() => {
    throw new Error('Codex command is missing');
  });
  if (!(await runVersion(normalized, Bun.spawn))) throw new Error('Codex command is not a valid installation');
  return normalized;
}
