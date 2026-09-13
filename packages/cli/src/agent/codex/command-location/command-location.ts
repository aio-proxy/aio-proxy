import { access, lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize } from 'node:path';

export type CommandLocationOptions = {
  readonly pathEnv?: string;
  readonly candidates?: readonly string[];
  readonly spawn?: typeof Bun.spawn;
};

const candidateNames = new Set(['aiop', 'aio-proxy']);

function isPublishedLauncher(path: string): boolean {
  const normalized = normalize(path).replaceAll('\\', '/');
  return /(?:^|\/)(?:node_modules\/)?aio-proxy\/bin\/(?:aio-proxy|aiop)\.js$/u.test(normalized);
}

function isAllowedName(path: string): boolean {
  const name = basename(path);
  return candidateNames.has(name) || ((name === 'aio-proxy.js' || name === 'aiop.js') && isPublishedLauncher(path));
}

function isDevelopmentPath(path: string): boolean {
  const normalized = normalize(path);
  return (
    normalized.endsWith('/bun') ||
    normalized.endsWith('/node') ||
    normalized.includes('/node_modules/.bin/') ||
    (normalized.endsWith('.js') && !isPublishedLauncher(normalized)) ||
    normalized.endsWith('.ts') ||
    normalized.includes('/src/') ||
    normalized.includes('/scripts/')
  );
}

async function runVersion(path: string, spawn: typeof Bun.spawn): Promise<boolean> {
  try {
    const child = spawn([path, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    // Drain both pipes while the process runs. A noisy invalid entry must not
    // deadlock discovery, and a broken launcher must not hold the CLI forever.
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text().catch(() => '');
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text().catch(() => '');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = Promise.all([child.exited, stdout, stderr]);
    const result = await Promise.race([
      completed.then(([status, output]) => ({ status, output })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 3_000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === undefined) {
      child.kill();
      void child.stdout?.cancel().catch(() => {});
      void child.stderr?.cancel().catch(() => {});
      return false;
    }
    return result.status === 0 && /^(?:(?:aiop|aio-proxy)(?:-cli)?\s+)?\d+\.\d+\.\d+\s*$/iu.test(result.output);
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
