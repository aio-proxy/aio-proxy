import { createPluginRepository, Router } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { type CredentialPort, definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../../src/server-state";
import { cleanup, flushMicrotasks, seedOAuthAccount } from "./test-support";

afterEach(cleanup);

test("a credential diagnostic raised during initial runtime creation rebuilds after manager initialization", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-startup-diagnostic-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  repository.writePluginSecret("@example/oauth", null, { apiKey: "plugin-secret" });
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: {},
      secrets: { clientSecret: "account-secret" },
      credential: { token: "secret" },
      catalog: {
        kind: "replace",
        value: {
          catalog: {
            language: [{ id: "model" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
          refreshedAt: Date.now(),
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
  handle.close();
  const descriptor = definePlugin(
    (api, pluginOptions) => {
      api.oauth.register({
        id: "default",
        label: "Example",
        account: { options: { schema: zod.object({}), form: [] } },
        credentials: zod.object({ token: zod.string() }),
        async login() {
          throw new Error("not called");
        },
        catalog: {
          policy: { kind: "static" },
          async discover() {
            throw new Error("not called");
          },
        },
        async createRuntime({ credentials }) {
          const current = await credentials.read();
          await credentials
            .refresh(current.revision, async () => {
              throw new Error(`secret account-secret ${(pluginOptions as { apiKey: string }).apiKey}`);
            })
            .catch(() => {});
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
      });
    },
    {
      options: {
        schema: zod.object({ apiKey: zod.string() }),
        form: [{ type: "secret", key: "apiKey", label: "API key" }],
      },
    },
  );
  const logs: unknown[] = [];
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    }),
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    pluginLogger: (entry) => logs.push(entry),
  });

  try {
    expect(state.currentProviderSnapshot().providerStates?.get("person")).toMatchObject({
      status: "unavailable",
      diagnostic: { code: "CREDENTIAL_REFRESH_FAILED" },
    });
    expect(JSON.stringify(logs)).not.toMatch(/account-secret|plugin-secret/u);
  } finally {
    state.close();
    rmSync(home, { force: true, recursive: true });
  }
});

test("a credential diagnostic raised after close does not rebuild the server snapshot", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-closed-diagnostic-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  let credentialPort: CredentialPort<{ token: string }> | undefined;
  let routerBuilds = 0;
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example",
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error("not called");
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          throw new Error("not called");
        },
      },
      async createRuntime({ credentials }) {
        credentialPort = credentials;
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
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    }),
    pluginRepository: repository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    pluginLogger: () => {},
    __test: {
      createRouter(providers: never[]) {
        routerBuilds++;
        return new Router(providers);
      },
    },
  } as never);

  try {
    expect(routerBuilds).toBe(1);
    state.close();
    const current = await credentialPort?.read();
    if (credentialPort === undefined || current === undefined) throw new Error("credential port was not created");
    await credentialPort
      .refresh(current.revision, async () => {
        throw new Error("late refresh failure");
      })
      .catch(() => {});
    await flushMicrotasks();
    await Bun.sleep(50);

    expect(routerBuilds).toBe(1);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
