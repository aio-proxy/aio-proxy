// The identity probe's GET, over a connection whose serving end is proven to be this user's before the
// bearer is written. A listener check alone leaves a window: the proxy can exit and another account
// take the port between that check and a separate `fetch`. Mirrors the app's `client/listener.rs`.

export type Run = (cmd: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;

export type Socket = { readonly uid: number; readonly family: string; readonly address: string };

/** The sockets in `lsof -F tun` output: each file's family and name, under its process's uid. */
export function parseSockets(lsofOutput: string): readonly Socket[] {
  const sockets: Socket[] = [];
  let uid = -1;
  let family = '';
  for (const line of lsofOutput.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('u')) uid = Number(value);
    else if (line.startsWith('f')) family = '';
    else if (line.startsWith('t')) family = value;
    else if (line.startsWith('n')) sockets.push({ uid, family, address: value });
  }
  return sockets;
}

const endpoint = (host: string, port: number | string): string =>
  host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;

/** `uid` holds the serving end of the connection from `local` to `peer`, which lsof names `peer->local`. */
export function servesConnection(sockets: readonly Socket[], uid: number, peer: string, local: string): boolean {
  return sockets.some((socket) => socket.uid === uid && socket.address === `${peer}->${local}`);
}

const RETRY_MS = 25;

async function servedByUs(run: Run, uid: number, peer: string, local: string, localPort: number, deadline: number) {
  for (;;) {
    try {
      const { stdout } = await run(['/usr/sbin/lsof', '-nP', `-iTCP:${localPort}`, '-Ftun']);
      if (servesConnection(parseSockets(stdout), uid, peer, local)) return true;
    } catch {
      return false;
    }
    // The server may not have accepted the connection yet.
    if (Date.now() + RETRY_MS >= deadline) return false;
    await Bun.sleep(RETRY_MS);
  }
}

/** A `Connection: close` HTTP/1.1 response: its status and body (chunked or not). */
export function parseResponse(raw: string): { readonly status: number; readonly body: string } | undefined {
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) return undefined;
  const [statusLine = '', ...headers] = raw.slice(0, split).split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(statusLine)?.[1]);
  if (!Number.isInteger(status)) return undefined;
  let body = raw.slice(split + 4);
  if (headers.some((h) => /^transfer-encoding:\s*chunked$/iu.test(h))) {
    let decoded = '';
    for (;;) {
      const end = body.indexOf('\r\n');
      const size = Number.parseInt(body.slice(0, end), 16);
      if (end < 0 || !Number.isFinite(size) || size === 0) break;
      decoded += body.slice(end + 2, end + 2 + size);
      body = body.slice(end + 2 + size + 2);
    }
    body = decoded;
  }
  return { status, body };
}

/**
 * GETs `path` from `host:port` with the bearer, only after `lsof` shows this user's socket serving
 * this very connection; otherwise sends nothing and returns `undefined`. Loopback only: the caller
 * has already reduced the address to a literal loopback host.
 */
export async function verifiedGet(
  run: Run,
  uid: number,
  host: string,
  port: string,
  path: string,
  token: string,
  timeoutMs: number,
): Promise<{ readonly status: number; readonly body: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  const chunks: Uint8Array[] = [];
  const { promise: closed, resolve: close } = Promise.withResolvers<void>();
  let socket: Awaited<ReturnType<typeof Bun.connect>>;
  try {
    socket = await Bun.connect({
      hostname: host,
      port: Number(port),
      socket: {
        data: (_, data) => void chunks.push(new Uint8Array(data)),
        close: () => close(),
        error: () => close(),
      },
    });
  } catch {
    return undefined;
  }
  try {
    const ours = await servedByUs(
      run,
      uid,
      endpoint(host, port),
      endpoint(host, socket.localPort),
      socket.localPort,
      deadline,
    );
    if (!ours) return undefined;
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${endpoint(host, port)}\r\nAuthorization: Bearer ${token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
    );
    const timedOut = await Promise.race([
      closed.then(() => false),
      Bun.sleep(Math.max(0, deadline - Date.now())).then(() => true),
    ]);
    if (timedOut) return undefined;
  } finally {
    socket.end();
  }
  return parseResponse(Buffer.concat(chunks).toString('utf8'));
}
