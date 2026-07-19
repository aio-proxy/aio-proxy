import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicConfigFile, createPluginRegistryHost, createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { zod } from "@aio-proxy/plugin-sdk";
import { createOAuthLoginSessionManager } from "./manager";

test("a cancelled OAuth session stays cancelled when a committed login finishes reloading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aio-oauth-session-cancel-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ plugins: [], providers: {} }));
  const database = openDb({ home: dir });
  const repository = createPluginRepository(database.sqlite);
  const host = createPluginRegistryHost();
  const staging = host.stage("@example/oauth");
  staging.api.oauth.register({
    id: "default",
    label: "Example OAuth",
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      return { fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "secret" } };
    },
    catalog: {
      policy: { kind: "static" },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error("not used");
    },
  });
  staging.seal();
  staging.commit();

  let reloadStarted!: () => void;
  let finishReload!: () => void;
  let sessionFinished!: () => void;
  const reloading = new Promise<void>((resolve) => {
    reloadStarted = resolve;
  });
  const reloadBlocked = new Promise<void>((resolve) => {
    finishReload = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    sessionFinished = resolve;
  });
  const manager = createOAuthLoginSessionManager({
    configFile: new AtomicConfigFile(configPath),
    repository,
    acquireRegistry: () => ({ registry: host.registry, release: sessionFinished }),
    diagnostics: (code, options) => ({
      code,
      summary: code,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    reload: async () => {
      reloadStarted();
      await reloadBlocked;
    },
  });

  try {
    const session = manager.start({
      capability: { plugin: "@example/oauth", capability: "default" },
      publicValues: {},
      secrets: {},
      clearSecrets: [],
    });
    await reloading;
    expect(manager.cancel(session.id)).toMatchObject({ status: "cancelled" });
    finishReload();
    await finished;
    expect(manager.get(session.id)).toMatchObject({ status: "cancelled" });
  } finally {
    manager.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
