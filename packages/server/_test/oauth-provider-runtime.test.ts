import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "@aio-proxy/oauth";
import { ConfigSchema, ProviderKind } from "@aio-proxy/types";
import { materializeProviders } from "../src/provider-runtime";

describe("OAuth provider runtime", () => {
  let dir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.AIO_PROXY_HOME;
    dir = mkdtempSync(join(tmpdir(), "aio-proxy-oauth-runtime-"));
    process.env.AIO_PROXY_HOME = dir;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.AIO_PROXY_HOME;
    } else {
      process.env.AIO_PROXY_HOME = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("materializes cached Copilot models as invoke-capable OAuth provider", () => {
    Auth.set("github-copilot", "copilot-12345", {
      access: "copilot-token",
      refresh: "github-token",
      expires: Date.now() + 60_000,
      baseUrl: "https://api.individual.githubcopilot.com",
    });

    const runtime = materializeProviders(
      ConfigSchema.parse({
        providers: {
          "copilot-12345": {
            kind: "oauth",
            vendor: "github-copilot",
            models: [
              { alias: "gpt-5-mini", id: "gpt-5-mini", transport: "chat" },
              { alias: "claude-sonnet-4", id: "claude-sonnet-4", transport: "messages" },
              { alias: "gpt-5", id: "gpt-5", transport: "responses" },
            ],
          },
        },
      }),
    );

    const provider = runtime.providers[0];
    expect(provider).toMatchObject({
      id: "copilot-12345",
      kind: ProviderKind.OAuth,
      models: [
        { alias: "gpt-5-mini", id: "gpt-5-mini" },
        { alias: "claude-sonnet-4", id: "claude-sonnet-4" },
        { alias: "gpt-5", id: "gpt-5" },
      ],
    });
    expect(provider).toHaveProperty("invoke");
    expect(provider?.models).toHaveLength(3);
  });
});
