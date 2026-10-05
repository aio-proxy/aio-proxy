import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { websocket } from '@aio-proxy/server';

import { EDITS_MULTIPART_ENCODED_LIMIT } from '../../../core/src/ingress/openai-image/multipart-counters';
import { freePort } from '../../__tests__/cli-test-helpers';
import { MAX_REQUEST_BODY_SIZE, proxyServeOptions, shutdownProxyServer } from './run';

test('local Dashboard setup installs Pi and OMP from the injected adapter assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-adapters-'));
  const bin = join(root, 'bin');
  const pi = join(root, 'pi');
  const omp = join(root, 'omp');
  const port = freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  mkdirSync(bin);
  const paths = {
    opencode: join(root, 'opencode.js'),
    officialPi: join(root, 'official-pi.js'),
    omp: join(root, 'omp.js'),
  };

  try {
    await Bun.write(join(root, 'config.jsonc'), JSON.stringify({ server: { port }, providers: {} }));
    await Bun.write(paths.opencode, 'export default "embedded-opencode";\n');
    await Bun.write(paths.officialPi, 'export default "embedded-pi";\n');
    await Bun.write(paths.omp, 'export default "embedded-omp";\n');
    await Bun.write(join(bin, 'pi'), '#!/bin/sh\nprintf "0.99.2\\n"\n');
    await Bun.write(
      join(bin, 'omp'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf "17.3.7\\n"; else printf '%s\\n' '${omp}'; fi\n`,
    );
    chmodSync(join(bin, 'pi'), 0o755);
    chmodSync(join(bin, 'omp'), 0o755);

    const script = `
      import { mock } from 'bun:test';
      const os = await import('node:os');
      // Post-install inspection can recover Codex config, so isolate its home too.
      mock.module('node:os', () => ({
        ...os,
        homedir: () => ${JSON.stringify(root)},
        default: { ...os.default, homedir: () => ${JSON.stringify(root)} },
      }));
      const { localAgentHost } = await import(${JSON.stringify(join(import.meta.dir, 'run.ts'))});
      const deps = {
        dashboardAssets: () => () => null,
        agentAssetPaths: () => (${JSON.stringify(paths)}),
      };
      const setup = await localAgentHost('127.0.0.1', ${port}, deps, {
        env: process.env,
        home: () => ${JSON.stringify(root)},
        resolveEndpoint: async () => ${JSON.stringify(endpoint)},
      });
      if (setup === undefined) throw new Error('local Dashboard setup was not enabled');
      for (const target of ['pi', 'omp']) {
        await setup.agentHost.configure(target, {}, {
          signal: new AbortController().signal,
          onDevice: () => {},
        });
      }
    `;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIO_PROXY_HOME: root,
      AIO_PROXY_AGENT_HOST: 'enabled',
      PI_CODING_AGENT_DIR: pi,
      PATH: `${bin}:/usr/bin:/bin`,
    };
    for (const key of ['CODEX_HOME', 'CODEX_SQLITE_HOME', 'GROK_CONFIG', 'XDG_CONFIG_HOME']) delete env[key];
    const child = Bun.spawn([process.execPath, '-e', script], {
      env,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    try {
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      expect(await Bun.file(join(pi, 'extensions/aio-proxy/index.js')).text()).toBe('export default "embedded-pi";\n');
      expect(await Bun.file(join(omp, 'extensions/aio-proxy/index.js')).text()).toBe(
        'export default "embedded-omp";\n',
      );
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test('serve maxRequestBodySize matches the edits multipart encoded limit', () => {
  expect(MAX_REQUEST_BODY_SIZE).toBe(EDITS_MULTIPART_ENCODED_LIMIT);
  expect(MAX_REQUEST_BODY_SIZE).toBeGreaterThanOrEqual(851_048_559);
});

/** The realtime routes attach through `upgradeWebSocket`, which calls `server.upgrade()` —
 *  something no `app.request()` test can reach, and something Bun refuses outright unless the
 *  `Bun.serve` call site carries a `websocket` handler. Bound as a real server here so a
 *  missing `websocket` key, or a `fetch` wrapper that drops Bun's second argument (the route
 *  reaches the server through `c.env`), is a failed upgrade rather than a silent 503 in
 *  production. */
test('the proxy serve options can complete a real websocket upgrade and relay a frame', async () => {
  // Stands in for the Hono app: it upgrades through the same `ws.data.events` contract that
  // `hono/bun`'s `upgradeWebSocket` uses, so the handler under test is the production one.
  const app = {
    fetch: (request: Request, server?: { upgrade: (request: Request, options: unknown) => boolean }) => {
      if (server === undefined) return new Response('fetch lost Bun’s server argument', { status: 500 });
      const upgraded = server.upgrade(request, {
        data: {
          url: new URL(request.url),
          protocol: '',
          events: {
            onOpen: (_event: Event, ws: { send: (data: string) => void }) => ws.send('opened'),
            onMessage: (event: { data: unknown }, ws: { send: (data: string) => void }) =>
              ws.send(`echo:${String(event.data)}`),
          },
        },
      });
      return upgraded ? undefined : new Response('not upgraded', { status: 400 });
    },
  };

  const server = Bun.serve(proxyServeOptions(app as never, '127.0.0.1', 0));
  try {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/v1/live/call_abc`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('error', () => reject(new Error('the upgrade was refused')));
      client.addEventListener('message', (event: MessageEvent<string>) => {
        received.push(event.data);
        if (received.length === 2) resolve();
      });
      client.addEventListener('open', () => client.send('ping'));
      setTimeout(() => reject(new Error(`only received ${received.length} frames: ${received.join(', ')}`)), 5_000);
    });

    expect(received).toEqual(['opened', 'echo:ping']);
    client.close(1_000);
  } finally {
    server.stop(true);
  }
});

/** The realtime shutdown contract, measured over a real upgraded socket.
 *
 *  Bun 1.4.2 dispatches an upgraded socket's `close` handler **synchronously inside**
 *  `server.stop(true)`, with code `1006`. `1006` is in the relay's unforwardable set and
 *  normalizes to `1011`, so with the force stop first the relay tore itself down on `1011` and
 *  latched, and the store's own shutdown close — the `1001` the design spec pins — never went out.
 *
 *  `appClose` here stands in for `app.close()` -> `realtimeCalls.close()`: it closes the live
 *  socket with `1001`, exactly as the call store's teardown does. The assertion is on the code the
 *  CLIENT observed on the wire, which is the only place the two orderings are distinguishable.
 *
 *  Fails on a marker rather than hanging: the race resolves on whichever of the close event or the
 *  deadline lands first, and a missing close is reported as `no close observed`. */
test('proxy shutdown closes a live upgraded socket with 1001, not a force-closed 1006', async () => {
  let liveSocket: { close: (code?: number, reason?: string) => void } | undefined;
  const app = {
    fetch: (request: Request, server?: { upgrade: (request: Request) => boolean }) =>
      server?.upgrade(request) === true ? undefined : new Response('not upgraded', { status: 400 }),
    // What `state.close()` does for realtime: close every live relay with the shutdown code.
    close: () => liveSocket?.close(1_001, 'server shutting down'),
  };

  const server = Bun.serve({
    ...proxyServeOptions(app as never, '127.0.0.1', 0),
    websocket: {
      open: (ws) => {
        liveSocket = ws;
      },
      message: () => {},
      close: () => {},
    },
  });

  const client = new WebSocket(`ws://127.0.0.1:${server.port}/v1/live/call_abc`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the upgrade never opened')), 5_000);
    client.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    client.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the upgrade was refused'));
    });
  });
  // Guards the assertion below against passing because nothing was ever attached: with no live
  // socket, `appClose` is a no-op and BOTH orderings would report the same code.
  expect(liveSocket).toBeDefined();

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    client.addEventListener('close', (event: CloseEvent) => resolve({ code: event.code, reason: event.reason }));
    setTimeout(() => resolve({ code: -1, reason: 'no close observed' }), 5_000);
  });

  shutdownProxyServer(server, app);

  // 1006 is what `server.stop(true)` force-closing the socket looks like on the wire, and it is
  // what this observed before `app.close()` was moved ahead of the force stop.
  expect(await closed).toEqual({ code: 1_001, reason: 'server shutting down' });
});

/** The ordering half of the same contract, asserted without a socket so a failure names the cause
 *  rather than a close code. `app.close()` must be the first of the two, and `server.stop(true)`
 *  must still run when it throws — `ServerState.close()` rethrows its first resource-close failure,
 *  and a process that keeps listening is worse than a lost cleanup error. */
test('proxy shutdown closes the app before force-stopping, even when the app throws', () => {
  const order: string[] = [];
  const server = { stop: () => order.push('server.stop(true)') };

  shutdownProxyServer(server as never, { close: () => order.push('app.close()') });

  expect(order).toEqual(['app.close()', 'server.stop(true)']);

  const afterThrow: string[] = [];
  const failing = { stop: () => afterThrow.push('server.stop(true)') };

  expect(() =>
    shutdownProxyServer(failing as never, {
      close: () => {
        afterThrow.push('app.close()');
        throw new Error('resource close failed');
      },
    }),
  ).toThrow('resource close failed');
  expect(afterThrow).toEqual(['app.close()', 'server.stop(true)']);
});

/** Bun's `websocket` handler has its own idle window, defaulting to 120s; the top-level
 *  `idleTimeout: 255` does not carry over to an upgraded socket, so a long-quiet realtime
 *  session would be dropped at 120s without this. Asserted alongside the invariant that makes
 *  it safe: `websocket` is a module singleton shared by every importer of `hono/bun`, so it
 *  must be spread — mutating it would set the timeout for unrelated call sites too. */
test('the websocket handler carries its own 255s idle window without mutating Hono’s singleton', () => {
  const options = proxyServeOptions({ fetch: () => new Response(null) } as never, '127.0.0.1', 0);

  expect(options.websocket.idleTimeout).toBe(255);
  expect(options.idleTimeout).toBe(255);
  expect(options.websocket).not.toBe(websocket);
  expect(websocket).not.toHaveProperty('idleTimeout');
  // `sendPings` stays at its default `true`; pinning it here would be pinning Bun's default.
  expect(options.websocket).not.toHaveProperty('sendPings');
});

/** launchd never SIGKILLs a sidecar that outlives SIGTERM, so the process must bound its own exit.
 *  Run in a child process because the behavior under test is the process exiting. `releases` says
 *  whether the shutdown callback frees the only handle keeping the event loop alive, standing in for
 *  a clean shutdown (true) versus one stuck on an outbound connection (false). */
const stopWithSigterm = async (releases: boolean, deadlineMs = 1_000) => {
  const script = `
    import { onShutdownSignal } from ${JSON.stringify(join(import.meta.dir, 'run.ts'))};
    const busy = setInterval(() => {}, 1_000);
    onShutdownSignal(() => { ${releases ? 'clearInterval(busy);' : ''} }, ${deadlineMs});
    console.log('ready');
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' });
  await child.stdout.getReader().read();
  const started = performance.now();
  child.kill('SIGTERM');
  const code = await child.exited;
  return { code, elapsedMs: performance.now() - started };
};

test('a shutdown that leaves the event loop busy still exits cleanly at the deadline', async () => {
  const { code, elapsedMs } = await stopWithSigterm(false);
  expect(code).toBe(0);
  expect(elapsedMs).toBeGreaterThanOrEqual(900);
  expect(elapsedMs).toBeLessThan(3_000);
});

test('a clean shutdown exits at once instead of waiting for the deadline', async () => {
  // A deadline far above the assertion: a slow CI child start cannot fake a pass or a failure.
  const { code, elapsedMs } = await stopWithSigterm(true, 10_000);
  expect(code).toBe(0);
  expect(elapsedMs).toBeLessThan(3_000);
});

test('the real proxy listener admits a declared body above 128 MiB into the app', async () => {
  let declared: string | null = null;
  const app = {
    fetch: (request: Request) => {
      declared = request.headers.get('content-length');
      return new Response('APP_ADMITTED', { status: 422 });
    },
  };
  const server = Bun.serve(proxyServeOptions(app as never, '127.0.0.1', 0));
  const wire = Promise.withResolvers<string>();
  let received = '';
  const timer = setTimeout(() => wire.reject(new Error('listener did not dispatch into the app')), 5_000);
  let client: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  try {
    client = await Bun.connect({
      hostname: '127.0.0.1',
      port: server.port!,
      socket: {
        open(socket) {
          socket.write(
            'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 135266304\r\nConnection: close\r\n\r\n{}',
          );
        },
        data(_socket, data) {
          received += new TextDecoder().decode(data);
          if (received.includes('APP_ADMITTED')) wire.resolve(received);
        },
        error(_socket, error) {
          wire.reject(error);
        },
        close() {
          if (!received.includes('APP_ADMITTED')) wire.reject(new Error(received));
        },
      },
    });
    expect(await wire.promise).toContain('422');
    expect(declared).toBe('135266304');
  } finally {
    clearTimeout(timer);
    client?.terminate();
    server.stop(true);
  }
});
