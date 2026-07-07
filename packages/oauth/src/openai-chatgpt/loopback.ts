const DEFAULT_LOOPBACK_PORT = 1_455;
const LOOPBACK_PATH = "/auth/callback";
const LOOPBACK_SUCCESS_HTML = "<html><body>You may close this window</body></html>";

export type LoopbackCode = {
  readonly code: string;
  readonly state: string;
};

export type LoopbackServerOptions = {
  readonly port?: number;
};

export class ChatGPTOAuthPortInUseError extends Error {
  override readonly name = "ChatGPTOAuthPortInUseError";

  constructor(
    readonly port: number,
    override readonly cause: unknown,
  ) {
    super(`ChatGPT loopback server could not listen on port ${port}`, { cause });
  }
}

export class ChatGPTStateMismatchError extends Error {
  override readonly name = "ChatGPTStateMismatchError";

  constructor(
    readonly expectedState: string,
    readonly actualState: string | null,
  ) {
    super(
      actualState === null
        ? `ChatGPT loopback callback is missing state; expected ${expectedState}`
        : `ChatGPT loopback state mismatch: expected ${expectedState}, got ${actualState}`,
    );
  }
}

export class ChatGPTOAuthAbortedError extends Error {
  override readonly name = "ChatGPTOAuthAbortedError";

  constructor() {
    super("ChatGPT loopback authentication was aborted");
  }
}

export class ChatGPTOAuthCallbackError extends Error {
  override readonly name = "ChatGPTOAuthCallbackError";

  constructor(readonly missingFields: readonly ("code" | "state")[]) {
    super(`ChatGPT loopback callback is missing ${missingFields.join(" and ")}`);
  }
}

type SettledResult =
  | { readonly ok: true; readonly value: LoopbackCode }
  | { readonly ok: false; readonly error: Error };

type Waiter = {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: LoopbackCode) => void;
};

export type LoopbackServer = {
  readonly redirectUri: string;
  close: () => void;
  waitForCode: (signal?: AbortSignal) => Promise<LoopbackCode>;
};

export function createLoopbackServer(expectedState: string, options: LoopbackServerOptions = {}): LoopbackServer {
  const port = options.port ?? DEFAULT_LOOPBACK_PORT;
  let settled: SettledResult | undefined;
  let closed = false;
  let waitPromise: Promise<LoopbackCode> | undefined;
  let waiter: Waiter | undefined;
  let abortSignal: AbortSignal | undefined;
  let abortListener: (() => void) | undefined;

  const stopServer = () => {
    if (closed) {
      return;
    }
    closed = true;
    server.stop();
  };

  const clearAbortListener = () => {
    if (abortSignal !== undefined && abortListener !== undefined) {
      abortSignal.removeEventListener("abort", abortListener);
    }
    abortSignal = undefined;
    abortListener = undefined;
  };

  const settle = (result: SettledResult) => {
    if (settled !== undefined) {
      return;
    }
    settled = result;
    clearAbortListener();
    if (waiter !== undefined) {
      const current = waiter;
      waiter = undefined;
      if (result.ok) {
        current.resolve(result.value);
      } else {
        current.reject(result.error);
      }
    }
    queueMicrotask(stopServer);
  };

  const fail = (error: Error) => {
    settle({ error, ok: false });
    return error;
  };

  const fetch = (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname !== LOOPBACK_PATH) {
      return new Response("Not Found", { status: 404 });
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (code === null || state === null) {
      const missingFields: ("code" | "state")[] = [];
      if (code === null) {
        missingFields.push("code");
      }
      if (state === null) {
        missingFields.push("state");
      }
      const error = new ChatGPTOAuthCallbackError(missingFields);
      fail(error);
      return new Response(error.message, { status: 400 });
    }

    if (state !== expectedState) {
      const error = new ChatGPTStateMismatchError(expectedState, state);
      fail(error);
      return new Response(error.message, { status: 400 });
    }

    const value = { code, state } as const satisfies LoopbackCode;
    settle({ ok: true, value });
    return new Response(LOOPBACK_SUCCESS_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      fetch,
      hostname: "127.0.0.1",
      port,
    });
  } catch (cause) {
    throw new ChatGPTOAuthPortInUseError(port, cause);
  }

  const redirectUri = new URL(LOOPBACK_PATH, `http://localhost:${server.port}`).toString();

  return {
    close: () => {
      if (settled === undefined) {
        settle({ error: new ChatGPTOAuthAbortedError(), ok: false });
        return;
      }
      stopServer();
    },
    redirectUri,
    waitForCode: async (signal?: AbortSignal) => {
      if (settled !== undefined) {
        if (settled.ok) {
          return settled.value;
        }
        throw settled.error;
      }

      if (waitPromise !== undefined) {
        return await waitPromise;
      }

      if (signal?.aborted === true) {
        const error = new ChatGPTOAuthAbortedError();
        settle({ error, ok: false });
        throw error;
      }

      waitPromise = new Promise<LoopbackCode>((resolve, reject) => {
        waiter = { resolve, reject };
      });

      if (signal !== undefined) {
        abortSignal = signal;
        abortListener = () => {
          const error = new ChatGPTOAuthAbortedError();
          settle({ error, ok: false });
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }

      return await waitPromise;
    },
  };
}
