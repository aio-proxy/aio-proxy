import type { CredentialPort, CredentialSnapshot } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { GoogleAntigravityCredential } from "../schema";

import { forceRefreshGoogleCredential } from "./refresh";

const reasons = [
  ["Error", new Error("caller stopped")],
  ["DOMException", new DOMException("caller stopped", "AbortError")],
  ["non-Error", { kind: "caller-stopped" }],
] as const;

test.each(reasons)("preserves an already-aborted %s reason without starting refresh", async (_label, reason) => {
  const controller = new AbortController();
  controller.abort(reason);
  let refreshes = 0;
  const port = staticPort(() => {
    refreshes += 1;
    return Promise.resolve({ status: "superseded", snapshot: snapshot() });
  });

  await expect(forceRefreshGoogleCredential(port, { signal: controller.signal })).rejects.toBe(reason);
  expect(refreshes).toBe(0);
});

test.each(reasons)(
  "preserves a mid-refresh %s reason without cancelling the shared promise",
  async (_label, reason) => {
    const controller = new AbortController();
    let resolveRefresh = (_result: RefreshResult) => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const shared = new Promise<RefreshResult>((resolve) => {
      resolveRefresh = resolve;
    });
    const port = staticPort(() => {
      markStarted();
      return shared;
    });

    const waiting = forceRefreshGoogleCredential(port, { signal: controller.signal });
    await started;
    controller.abort(reason);
    const outcome = await Promise.race([
      waiting.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      Bun.sleep(25).then(() => "timeout"),
    ]);
    resolveRefresh({ status: "superseded", snapshot: snapshot() });
    await waiting.catch(() => undefined);

    expect(outcome).toBe(reason);
  },
);

test("a late shared rejection after caller abort does not become unhandled", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  const sharedFailure = new Error("shared refresh failed later");
  let rejectRefresh = (_error: Error) => {};
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const shared = new Promise<RefreshResult>((_resolve, reject) => {
    rejectRefresh = reject;
  });
  const port = staticPort(() => {
    markStarted();
    return shared;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const waiting = forceRefreshGoogleCredential(port, { signal: controller.signal });
    await started;
    controller.abort(reason);
    const outcome = await Promise.race([
      waiting.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      Bun.sleep(25).then(() => "timeout"),
    ]);
    rejectRefresh(sharedFailure);
    await waiting.catch(() => undefined);
    await Bun.sleep(0);
    expect(outcome).toBe(reason);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

type RefreshResult = Awaited<ReturnType<CredentialPort<GoogleAntigravityCredential>["refresh"]>>;

function staticPort(refresh: () => Promise<RefreshResult>): CredentialPort<GoogleAntigravityCredential> {
  return { read: async () => snapshot(), refresh };
}

function snapshot(): CredentialSnapshot<GoogleAntigravityCredential> {
  return { value: credential(), revision: 1 };
}

function credential(): GoogleAntigravityCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1,
    email: "person@example.com",
    projectId: "project-1",
  };
}
