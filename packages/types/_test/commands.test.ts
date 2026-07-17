import { describe, expect, test } from "bun:test";
import { pluginConfigCommand, providerLoginCommand } from "../src/commands";

const shells = ["bash", "zsh"].flatMap((name) => {
  const path = Bun.which(name);
  return path === null ? [] : [[name, path] as const];
});

function capturedArguments(shell: string, command: string): readonly string[] {
  const result = Bun.spawnSync([shell, "-c", `aio-proxy() { printf '%s\\0' "$@"; }\n${command}`], {
    env: { ...process.env, HOME: "/tmp/aio-proxy-command-test" },
  });
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout).split("\0").slice(0, -1);
}

describe("suggested CLI commands", () => {
  test("keeps validated provider and plugin identifiers readable", () => {
    expect(providerLoginCommand("provider-1")).toBe("aio-proxy provider login --provider provider-1");
    expect(pluginConfigCommand("@example/broken")).toBe("aio-proxy plugin config @example/broken");
  });

  test("quotes provider identifiers containing shell metacharacters", () => {
    expect(providerLoginCommand("provider; echo unsafe")).toBe(
      "aio-proxy provider login --provider 'provider; echo unsafe'",
    );
    expect(providerLoginCommand("provider'quoted")).toBe("aio-proxy provider login --provider 'provider'\"'\"'quoted'");
    expect(providerLoginCommand("~")).toBe("aio-proxy provider login --provider '~'");
    expect(providerLoginCommand("=ls")).toBe("aio-proxy provider login --provider '=ls'");
  });

  test.each(shells)("round-trips provider and plugin arguments through %s", (_name, shell) => {
    for (const value of ["~", "=ls", "two words", "semi;colon", "single'quote", "$(printf injected)", "`id`"]) {
      expect(capturedArguments(shell, providerLoginCommand(value))).toEqual(["provider", "login", "--provider", value]);
      expect(capturedArguments(shell, pluginConfigCommand(value))).toEqual(["plugin", "config", value]);
    }
  });
});
