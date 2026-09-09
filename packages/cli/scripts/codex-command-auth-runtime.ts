import { join } from 'node:path';

export type JsonRpcPacket = {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
};
export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};
type Child = { readonly kill: () => void; readonly exited: Promise<number> };
export type ProbeContext = {
  readonly deadline: number;
  readonly children: Set<Child>;
  readonly remaining: () => number;
  readonly stopAll: () => Promise<void>;
};
export type RpcSession = {
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly stop: () => Promise<void>;
};

export const timeoutMs = 10_000;

export function createContext(): ProbeContext {
  const children = new Set<Child>();
  const deadline = Date.now() + 45_000;
  return {
    deadline,
    children,
    remaining: () => Math.max(1, deadline - Date.now()),
    stopAll: async () => {
      for (const child of children) child.kill();
      await Promise.allSettled([...children].map((child) => child.exited));
      children.clear();
    },
  };
}

export function envFor(root: string, codexHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', HOME: root, CODEX_HOME: codexHome, TMPDIR: join(root, 'tmp'), ...extra };
}

export async function spawn(
  context: ProbeContext,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  input?: string,
  limit = timeoutMs,
): Promise<CommandResult> {
  const child = Bun.spawn([...args], {
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  context.children.add(child);
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.kill();
    },
    Math.min(limit, context.remaining()),
  );
  try {
    if (input !== undefined) {
      const stdin = child.stdin;
      if (stdin === undefined) throw new Error('child stdin unavailable');
      stdin.write(input);
      stdin.end();
    }
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    context.children.delete(child);
  }
}

export async function openRpcSession(
  context: ProbeContext,
  executable: string,
  root: string,
  codexHome: string,
  sanitize: (error: unknown) => string,
  extraEnv: Record<string, string> = {},
): Promise<RpcSession> {
  const child = Bun.spawn([executable, 'app-server'], {
    cwd: root,
    env: envFor(root, codexHome, extraEnv),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  context.children.add(child);
  const pending = new Map<number, (packet: JsonRpcPacket) => void>();
  const consume = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const packet = JSON.parse(line) as JsonRpcPacket;
          if (typeof packet.id === 'number') pending.get(packet.id)?.(packet);
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const stderr = new Response(child.stderr).text();
  let nextId = 0;
  const call = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error(`${method}: timeout`));
        },
        Math.min(timeoutMs, context.remaining()),
      );
      pending.set(id, (packet) => {
        clearTimeout(timer);
        pending.delete(id);
        if (packet.error !== undefined) reject(new Error(`${method}: ${packet.error.message ?? 'rejected'}`));
        else resolve(packet.result);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      child.stdin.flush();
    });
  };
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    child.kill();
    await child.exited;
    await consume;
    await stderr;
    context.children.delete(child);
  };
  try {
    await call('initialize', {
      clientInfo: { name: 'aio-proxy-command-auth-probe', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    child.stdin.flush();
    return { call, stop };
  } catch (error) {
    await stop();
    const details = await stderr;
    throw new Error(`${sanitize(error)}${details.trim() === '' ? '' : `; stderr=${sanitize(details)}`}`);
  }
}
