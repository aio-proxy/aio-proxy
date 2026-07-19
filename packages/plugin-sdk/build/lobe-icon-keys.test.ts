import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { iconKeysFromFileNames, prepareLobeIconTypeBuild, renderLobeIconKeyDeclaration } from "./lobe-icon-keys";

describe("Lobe icon key generation", () => {
  test("sorts valid SVG keys and renders a deterministic union", () => {
    const keys = iconKeysFromFileNames(["openai.svg", "anthropic.svg", "codex-color.svg"]);
    expect(keys).toEqual(["anthropic", "codex-color", "openai"]);
    expect(renderLobeIconKeyDeclaration(keys)).toBe(
      'export type LobeIconKey = "anthropic" | "codex-color" | "openai";\n',
    );
  });

  test.each([
    ["empty package", []],
    ["invalid uppercase key", ["OpenAI.svg"]],
    ["invalid separator", ["open_ai.svg"]],
    ["duplicate key", ["openai.svg", "openai.svg"]],
  ])("rejects %s", (_name, files) => {
    expect(() => iconKeysFromFileNames(files)).toThrow();
  });
});

test("prepares the exact helper declaration before Rslib evaluates its declaration pipeline", () => {
  const root = mkdtempSync(join(tmpdir(), "aio-proxy-lobe-icon-build-"));
  const iconsDirectory = join(root, "icons");

  try {
    mkdirSync(iconsDirectory);
    writeFileSync(join(iconsDirectory, "openai.svg"), "");
    const prepared = prepareLobeIconTypeBuild({
      cachePath: join(root, "cache"),
      iconsDirectory,
      version: "1.93.0",
    });

    expect(readFileSync(prepared.declarationPath, "utf8")).toBe('declare type AioProxyLobeIconKey = "openai";\n');
    expect(prepared.declaration).toBe('declare type AioProxyLobeIconKey = "openai";\n');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
