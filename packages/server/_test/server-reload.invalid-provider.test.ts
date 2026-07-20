import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loopbackServer } from "../src/dashboard-auth/test-support";
import { configWithProvider, writeConfig } from "./server-reload.oauth.test-support";

describe("server invalid provider reload", () => {
  test("Given invalid provider config reload When reload is requested Then the provider degrades independently", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-reload-"));
    const configPath = join(dir, "config.jsonc");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ servedBy: "old-openai" }, { status: 208 });
      },
    });
    const initialConfig = configWithProvider("old-openai", `http://127.0.0.1:${upstream.port}`);
    writeConfig(configPath, initialConfig);
    const app = await createServer({
      config: initialConfig,
      configPath,
      watchConfig: false,
    });

    try {
      writeConfig(configPath, {
        providers: {
          duplicate: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://duplicate.example.com",
            models: ["first-model", "second-model"],
            alias: {
              "first-model": { model: "second-model", preserve: false },
              firstAlias: { model: "first-model", preserve: true },
            },
          },
        },
      });

      // When
      const reload = await app.request(
        "/dashboard/api/reload",
        {
          headers: { Origin: "http://127.0.0.1:22078" },
          method: "POST",
        },
        loopbackServer,
      );
      const providers = await app.request("/dashboard/api/providers/duplicate", undefined, loopbackServer);
      const body = await providers.json();

      // Then
      expect(reload.status).toBe(200);
      expect(providers.status).toBe(200);
      expect(body.provider).toMatchObject({ id: "duplicate", enabled: false, clientModels: [] });
    } finally {
      await upstream.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
