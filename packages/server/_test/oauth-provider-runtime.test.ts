import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "@aio-proxy/core";
import { Auth } from "@aio-proxy/oauth";
import { ConfigSchema, OAuthVendor, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { materializeProviders } from "../src/provider-runtime";

const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

describe("OAuth provider runtime", () => {
  let dir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    warnSpy.mockClear();
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
    warnSpy.mockClear();
  });

  test("derives self-alias routes from cached vendor models for a bare config", () => {
    Auth.set("github-copilot", "copilot-12345", {
      access: "tok",
      refresh: "r",
      expires: Date.now() + 60_000,
      baseUrl: "https://api.individual.githubcopilot.com",
      models: [
        { id: "gpt-5-mini", displayName: "GPT 5 Mini", transport: ProviderProtocol.OpenAICompatible },
        { id: "claude-sonnet-4", displayName: "Claude Sonnet 4", transport: ProviderProtocol.Anthropic },
      ],
    });

    const runtime = materializeProviders(
      ConfigSchema.parse({
        providers: { "copilot-12345": { kind: "oauth", vendor: "github-copilot" } },
      }),
    );

    const provider = runtime.providers[0];
    expect(provider).toMatchObject({ id: "copilot-12345", kind: ProviderKind.OAuth });
    expect(provider?.models).toEqual(["gpt-5-mini", "claude-sonnet-4"]);
    expect(provider?.alias).toMatchObject({
      "gpt-5-mini": { model: "gpt-5-mini", preserve: false },
      "claude-sonnet-4": { model: "claude-sonnet-4", preserve: false },
    });
    expect(provider?.modelMetadata).toMatchObject({
      "gpt-5-mini": { displayName: "GPT 5 Mini" },
      "claude-sonnet-4": { displayName: "Claude Sonnet 4" },
    });

    const router = new Router(runtime.providers);
    expect(router.resolve("gpt-5-mini")[0]?.modelId).toBe("gpt-5-mini");
    expect(router.resolve("claude-sonnet-4")[0]?.modelId).toBe("claude-sonnet-4");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("lets a config alias rename replace the auto self-alias for the targeted model", () => {
    Auth.set("github-copilot", "copilot-12345", {
      access: "tok",
      refresh: "r",
      expires: Date.now() + 60_000,
      baseUrl: "https://api.individual.githubcopilot.com",
      models: [
        { id: "gpt-5-mini", transport: ProviderProtocol.OpenAICompatible },
        { id: "claude-sonnet-4", transport: ProviderProtocol.Anthropic },
      ],
    });

    const runtime = materializeProviders(
      ConfigSchema.parse({
        providers: {
          "copilot-12345": {
            kind: "oauth",
            vendor: "github-copilot",
            alias: { mini: { model: "gpt-5-mini", preserve: false } },
          },
        },
      }),
    );

    const provider = runtime.providers[0];
    expect(provider?.alias).toMatchObject({
      mini: { model: "gpt-5-mini", preserve: false },
      "claude-sonnet-4": { model: "claude-sonnet-4", preserve: false },
    });
    expect(provider?.alias?.["gpt-5-mini"]).toBeUndefined();

    const router = new Router(runtime.providers);
    expect(router.resolve("mini")[0]?.modelId).toBe("gpt-5-mini");
    expect(() => router.resolve("gpt-5-mini")).toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("warns and exposes config-alias-only routes when the payload has no cached models", async () => {
    Auth.set("github-copilot", "copilot-nomodels", {
      access: "tok",
      refresh: "r",
      expires: Date.now() + 60_000,
      baseUrl: "https://api.individual.githubcopilot.com",
    });

    const runtime = materializeProviders(
      ConfigSchema.parse({
        providers: {
          "copilot-nomodels": {
            kind: "oauth",
            vendor: "github-copilot",
            alias: { x: { model: "anything", preserve: false } },
          },
        },
      }),
    );

    const provider = runtime.providers[0];
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("copilot-nomodels"));
    expect(provider?.models).toEqual([]);
    expect(provider?.alias).toEqual({ x: { model: "anything", preserve: false } });
    await expect(provider?.ensureAvailable?.()).rejects.toThrow("re-login to sync");
  });

  test("materializes oauth providers by vendor", () => {
    const runtime = materializeProviders(
      ConfigSchema.parse({
        providers: {
          copilot: { kind: "oauth", vendor: OAuthVendor.GitHubCopilot },
          chatgpt: { kind: "oauth", vendor: OAuthVendor.OpenAIChatGPT },
        },
      }),
    );

    expect(runtime.providers.map((provider) => provider.vendor)).toEqual([
      OAuthVendor.GitHubCopilot,
      OAuthVendor.OpenAIChatGPT,
    ]);
  });
});
