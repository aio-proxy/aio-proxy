import { ProviderKind } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";

import type { ServerLog } from "../server-log";

import { createObservedFetch, withAttemptLogContext, withRequestLogContext } from "../request-logging";
import { waitFor } from "../request-logging/wire.test-support";
import { cleanup, diagnostics, materializePluginProvider, runtimeFixture } from "./test-support";

afterEach(cleanup);

test("OAuth runtimes receive the observed host fetch", async () => {
  const logs: ServerLog[] = [];
  const baseFetchCalls: Request[] = [];
  const baseFetch = (async (input, init) => {
    baseFetchCalls.push(new Request(input, init));
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  let capturedFetch: typeof globalThis.fetch | undefined;
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      providerId: "oauth",
      async createRuntime(context) {
        capturedFetch = context.fetch;
        return {
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
        } as never;
      },
    },
  );

  await materializePluginProvider({
    config: {
      id: "oauth",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    runtimeFetch: createObservedFetch(baseFetch),
  });

  expect(capturedFetch).toBeFunction();

  await withRequestLogContext({ requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) }, () =>
    withAttemptLogContext({ attemptIndex: 0, providerId: "oauth", modelId: "model" }, () =>
      capturedFetch?.("https://oauth-upstream.test/v1", { method: "POST", body: "wire-secret" }),
    ),
  );

  await waitFor(() => logs.some(({ event }) => event === "request.upstream_snapshot"));
  expect(logs).toContainEqual(expect.objectContaining({ event: "request.upstream_snapshot", providerId: "oauth" }));
  expect(baseFetchCalls).toHaveLength(1);
});
