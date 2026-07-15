import { join } from "node:path";

const cli = [process.execPath, "run", "packages/cli/src/main.ts"] as const;
const repoRoot = join(import.meta.dir, "../../..");

type CliEnv = Record<string, string | undefined>;

const cliEnv = (env: CliEnv) => ({
  ...process.env,
  AIO_PROXY_LANG: undefined,
  LANG: "en_US.UTF-8",
  LANGUAGE: undefined,
  LC_ALL: undefined,
  LC_MESSAGES: undefined,
  AIO_PROXY_HOME: env.AIO_PROXY_HOME,
  ...env,
});

export const runCli = (args: readonly string[], env: CliEnv = {}) =>
  Bun.spawnSync([...cli, ...args], {
    cwd: repoRoot,
    env: cliEnv(env),
    stderr: "pipe",
    stdout: "pipe",
  });

export const runCliAsync = async (args: readonly string[], env: CliEnv = {}) => {
  const subprocess = Bun.spawn([...cli, ...args], {
    cwd: repoRoot,
    env: cliEnv(env),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stderr, stdout };
};

export const output = (result: Bun.SpawnSyncReturns<Uint8Array>) =>
  `${result.stdout.toString()}${result.stderr.toString()}`;

export const cliServeArgs = (port: number): readonly string[] => [...cli, "serve", "--port", String(port)];

export const repoCwd = repoRoot;

export const freePort = () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
};

type WaitForOkOptions = Readonly<{
  probeTimeoutMs: number;
  readinessTimeoutMs: number;
}>;

export async function waitForOk(url: string, options: WaitForOkOptions): Promise<Response> {
  const deadline = performance.now() + options.readinessTimeoutMs;
  let lastError: Error | undefined;

  while (performance.now() < deadline) {
    try {
      const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(options.probeTimeoutMs, remainingMs)),
      });
      if (response.ok) {
        return response;
      }
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      if (!(err instanceof Error)) {
        throw err;
      }
      lastError = err;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? ""}`);
}
