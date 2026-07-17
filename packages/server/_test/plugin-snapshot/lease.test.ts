import { afterEach, expect, test } from "bun:test";
import { Router, type TextStreamPart, type ToolSet } from "@aio-proxy/core";
import { createSnapshotManager } from "../../src/plugin-snapshot";
import { handleProtocolRequest } from "../../src/routes/pipeline";
import { createUsageCapture } from "../../src/usage-capture";
import {
  createProtocolContext,
  defineProtocolAdapter,
  defineProviderRouteSource,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
} from "../pipeline-helpers";
import { cleanup, emptyPlugins, snapshot } from "./test-support";

afterEach(cleanup);

test("an acquired old snapshot drains only after its one-shot lease releases", async () => {
  const manager = createSnapshotManager(snapshot("old"));
  const lease = manager.acquire();
  const retired = manager.swap(snapshot("new"));

  expect(manager.current().providers[0]?.id).toBe("new");
  expect(manager.canDeleteAccount("old")).toBe(false);
  let drained = false;
  void retired.whenDrained.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  lease.release();
  lease.release();
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});

test("an in-flight protocol response retains its old provider snapshot until the body completes", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const old = rawProvider({
    id: "old",
    modelId: REQUESTED_MODEL,
    invoke: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
        }),
      ),
  });
  const next = rawProvider({ id: "next", modelId: REQUESTED_MODEL });
  const manager = createSnapshotManager({
    plugins: emptyPlugins as never,
    providers: [old.provider],
    router: new Router([old.provider]),
  });
  const base = defineProviderRouteSource([old]);
  const source = {
    ...base.source,
    acquireProviderSnapshot: manager.acquire,
    currentProviderSnapshot: manager.current,
    usageCapture: createUsageCapture({ priceCatalogTask: async () => undefined }),
  };
  const response = await handleProtocolRequest({
    adapter: defineProtocolAdapter(),
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL }),
    source,
  });
  const retired = manager.swap({
    plugins: emptyPlugins as never,
    providers: [next.provider],
    router: new Router([next.provider]),
  });

  expect(manager.canDeleteAccount("old")).toBe(false);
  bodyController?.enqueue(new TextEncoder().encode('{"ok":true}'));
  bodyController?.close();
  expect(await response.text()).toBe('{"ok":true}');
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});

test.each([
  "EOF",
  "cancel",
] as const)("an in-flight model stream retains its old provider snapshot until response %s", async (completion) => {
  let modelController: ReadableStreamDefaultController<TextStreamPart<ToolSet>> | undefined;
  const old = modelProvider({
    id: "old",
    modelId: REQUESTED_MODEL,
    invoke: () =>
      new ReadableStream<TextStreamPart<ToolSet>>({
        start(controller) {
          modelController = controller;
          controller.enqueue({ type: "text-delta", id: "text-1", text: "old" });
        },
      }),
  });
  const next = modelProvider({
    id: "next",
    modelId: REQUESTED_MODEL,
    invoke: () => new ReadableStream<TextStreamPart<ToolSet>>({ start: (controller) => controller.close() }),
  });
  const manager = createSnapshotManager({
    plugins: emptyPlugins as never,
    providers: [old.provider],
    router: new Router([old.provider]),
  });
  const base = defineProviderRouteSource([old]);
  const source = {
    ...base.source,
    acquireProviderSnapshot: manager.acquire,
    currentProviderSnapshot: manager.current,
    usageCapture: createUsageCapture({ priceCatalogTask: async () => undefined }),
  };
  const response = await handleProtocolRequest({
    adapter: defineProtocolAdapter(),
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL, stream: true }),
    source,
  });
  const retired = manager.swap({
    plugins: emptyPlugins as never,
    providers: [next.provider],
    router: new Router([next.provider]),
  });

  expect(manager.canDeleteAccount("old")).toBe(false);
  if (completion === "EOF") {
    modelController?.close();
    expect(await response.text()).toContain('data: {"text":"old"}');
  } else {
    await response.body?.cancel();
  }
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});

test("a final raw error response retains its old provider snapshot until the body completes", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const old = rawProvider({
    id: "old",
    modelId: REQUESTED_MODEL,
    invoke: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
        }),
        { status: 500 },
      ),
  });
  const manager = createSnapshotManager({
    plugins: emptyPlugins as never,
    providers: [old.provider],
    router: new Router([old.provider]),
  });
  const base = defineProviderRouteSource([old]);
  const source = {
    ...base.source,
    acquireProviderSnapshot: manager.acquire,
    currentProviderSnapshot: manager.current,
  };
  const response = await handleProtocolRequest({
    adapter: defineProtocolAdapter(),
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL }),
    source,
  });
  const retired = manager.swap({ ...snapshot("empty"), providers: [] });

  expect(response.status).toBe(500);
  expect(manager.canDeleteAccount("old")).toBe(false);
  bodyController?.enqueue(new TextEncoder().encode("upstream failed"));
  bodyController?.close();
  expect(await response.text()).toBe("upstream failed");
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});
