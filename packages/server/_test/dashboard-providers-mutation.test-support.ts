import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "@aio-proxy/server";

const PORT = 22_079;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const seedConfig = {
  providers: {
    "seed-api": {
      kind: "api" as const,
      protocol: "openai-response" as const,
      baseURL: "https://api.example.com",
      apiKey: "sk-preserved-value",
      enabled: true,
      alias: { "gpt-4o": "gpt-4o-upstream" },
    },
    "seed-ai": { kind: "ai-sdk" as const, packageName: "@ai-sdk/openai-compatible", enabled: true },
    "seed-oauth": { kind: "oauth" as const, vendor: "legacy-provider", enabled: true },
  },
};
const createSeedConfig = () => structuredClone(seedConfig);

export async function createDashboardProviderFixture(prefix: string) {
  const config = createSeedConfig();
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(tmpDir, "config.jsonc");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // watchConfig:false — mutateProviders drives reload itself; no watcher needed.
  const app = await createServer({ config, configPath, watchConfig: false, port: PORT });

  return {
    config,
    onDisk: () =>
      JSON.parse(readFileSync(configPath, "utf8")) as { providers: Record<string, Record<string, unknown>> },
    req: (method: string, path: string, body?: unknown) =>
      app.request(`/dashboard/api${path}`, {
        method,
        headers: method === "GET" ? {} : { Origin: ORIGIN, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    requestPathlessProviders: async () => {
      const pathless = await createServer({ config: createSeedConfig(), port: PORT });
      return pathless.request("/dashboard/api/providers");
    },
    requestPathless: async (body: unknown) => {
      const pathless = await createServer({ config: createSeedConfig(), port: PORT });
      return pathless.request("/dashboard/api/providers", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}
