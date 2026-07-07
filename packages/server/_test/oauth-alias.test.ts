import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type ProviderInstance, Router, RouterModelCollisionError } from "@aio-proxy/core";
import { AliasConfigSchema } from "@aio-proxy/types";
import { deriveOAuthAlias } from "../src/oauth-alias";

const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => {
  warnSpy.mockClear();
});

describe("deriveOAuthAlias", () => {
  test("derives a self-alias for every model id when no config is given", () => {
    const result = deriveOAuthAlias(["gpt-5.5", "gpt-5.4"], undefined);

    expect(result).toEqual({
      "gpt-5.5": { model: "gpt-5.5", preserve: false },
      "gpt-5.4": { model: "gpt-5.4", preserve: false },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("lets a config rename replace the auto self-alias for the targeted model", () => {
    const result = deriveOAuthAlias(["gpt-5.5"], { gpt5: { model: "gpt-5.5", preserve: false } });

    expect(result).toEqual({ gpt5: { model: "gpt-5.5", preserve: false } });
    expect(Object.keys(result)).toEqual(["gpt5"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("does not duplicate when the config key equals the model id", () => {
    const result = deriveOAuthAlias(["mini"], { mini: { model: "mini", preserve: false } });

    expect(result).toEqual({ mini: { model: "mini", preserve: false } });
    expect(Object.keys(result)).toEqual(["mini"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("omits the auto self-alias when a preserve:true config targets the model", () => {
    const derived = deriveOAuthAlias(["claude"], { sonnet: { model: "claude", preserve: true } });

    expect(derived).toEqual({ sonnet: { model: "claude", preserve: true } });
    expect(Object.keys(derived)).toEqual(["sonnet"]);
    expect(warnSpy).not.toHaveBeenCalled();

    const provider = {
      id: "p",
      kind: "oauth",
      vendor: "github-copilot",
      enabled: true,
      alias: derived,
    } satisfies ProviderInstance;

    expect(() => new Router([provider])).not.toThrow();
  });

  test("a router built from an un-guarded preserve:true alias would collide", () => {
    const collidingProvider = {
      id: "p",
      kind: "oauth",
      vendor: "github-copilot",
      enabled: true,
      alias: {
        claude: { model: "claude", preserve: false },
        sonnet: { model: "claude", preserve: true },
      },
    } satisfies ProviderInstance;

    expect(() => new Router([collidingProvider])).toThrow(RouterModelCollisionError);
  });

  test("warns once and keeps the config entry when a target is not in the model list", () => {
    const result = deriveOAuthAlias(["gpt-5"], { unknown: { model: "not-in-list", preserve: false } });

    expect(result).toEqual({
      "gpt-5": { model: "gpt-5", preserve: false },
      unknown: { model: "not-in-list", preserve: false },
    });
    expect(Object.keys(result)).toEqual(["gpt-5", "unknown"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not-in-list"));
  });

  test("keeps config-only entries from string shorthand and warns for unknown targets", () => {
    const config = { mymodel: AliasConfigSchema.parse("gpt-X") };

    const result = deriveOAuthAlias([], config);

    expect(result).toEqual({ mymodel: { model: "gpt-X", preserve: false } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("gpt-X"));
  });

  test("returns an empty record when both inputs are empty", () => {
    expect(deriveOAuthAlias([], undefined)).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
