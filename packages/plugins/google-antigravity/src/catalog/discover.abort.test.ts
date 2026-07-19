import { expect, test } from "bun:test";
import type { AccountContext, OAuthAdapter, PluginDescriptor } from "@aio-proxy/plugin-sdk";
import { createGoogleAntigravityPlugin } from "../plugin";
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from "../schema";
import { discoverAntigravityCatalog } from "./discover";

test("propagates a caller abort before daily without attempting either endpoint", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled before discovery");
  controller.abort(reason);
  let attempts = 0;

  const error = await captureThrown(() =>
    discoverAntigravityCatalog(context(controller.signal), {
      fetch: async () => {
        attempts += 1;
        return Response.json({ models: { model: {} } });
      },
    }),
  );

  expect(error).toBe(reason);
  expect(error).not.toHaveProperty("snapshotEligible");
  expect(attempts).toBe(0);
});

test("propagates a caller abort during daily without trying prod", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled during discovery");
  let attempts = 0;

  const error = await captureThrown(() =>
    discoverAntigravityCatalog(context(controller.signal), {
      fetch: async () => {
        attempts += 1;
        controller.abort(reason);
        throw new DOMException("request aborted", "AbortError");
      },
    }),
  );

  expect(error).toBe(reason);
  expect(error).not.toHaveProperty("snapshotEligible");
  expect(attempts).toBe(1);
});

test("adapter does not convert caller cancellation into an initial snapshot fallback", async () => {
  const adapter = await adapterFrom(createGoogleAntigravityPlugin());
  const controller = new AbortController();
  const reason = new Error("host cancelled account discovery");
  controller.abort(reason);

  const error = await captureThrown(() => adapter.catalog.discover(context(controller.signal)));

  expect(error).toBe(reason);
  expect(adapter.catalog.initialFallback?.(error)).toBeUndefined();
});

function context(signal: AbortSignal): AccountContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions> {
  const value: GoogleAntigravityCredential = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Number.MAX_SAFE_INTEGER,
    email: "person@example.com",
    projectId: "project-1",
  };
  return {
    options: {},
    signal,
    credentials: {
      read: async () => ({ value, revision: 1 }),
      refresh: async () => ({ status: "superseded", snapshot: { value, revision: 1 } }),
    },
  };
}

async function captureThrown(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential>> {
  let adapter: OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential> | undefined;
  await descriptor.setup({ oauth: { register: (value) => (adapter = value as typeof adapter) } }, undefined);
  if (adapter === undefined) throw new Error("adapter was not registered");
  return adapter;
}
