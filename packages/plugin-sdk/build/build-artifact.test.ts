import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("build exposes exact Lobe icon keys without bundling them into runtime JavaScript", () => {
  const packagePath = resolve(import.meta.dirname, "..");
  const sdkEntry = join(packagePath, "dist", "index.d.ts");
  const declaration = readFileSync(sdkEntry, "utf8");
  const runtime = readFileSync(join(packagePath, "dist", "index.js"), "utf8");

  expect(declaration).toContain("export declare type LobeIconKey");
  expect(declaration).toContain('"openai"');
  expect(declaration).toContain('"githubcopilot"');
  expect(declaration).not.toContain("#aio-proxy/lobe-icon-key");
  expect(declaration).not.toContain("@aio-proxy/plugin-sdk-internal-lobe-icon-key");
  expect(declaration).not.toContain("lobe-icon-key-placeholder");
  expect(declaration).not.toContain("node_modules/.cache");
  expect(declaration).not.toContain(packagePath);
  expect(runtime).not.toContain('"githubcopilot"');
  expect(runtime).not.toContain("lobeIconKeys");

  const fixtureDirectory = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-sdk-icon-types-"));
  const fixturePath = join(fixtureDirectory, "fixture.ts");
  const fixtureSource = `
import type { OAuthIcon } from ${JSON.stringify(sdkEntry)};

const lobe: OAuthIcon = "openai";
const http: OAuthIcon = "http://example.com/icon.svg";
const https: OAuthIcon = "https://example.com/icon.svg";
const data: OAuthIcon = "data:image/png;base64,iVBORw0KGgo=";

// @ts-expect-error the built declaration must reject unknown Lobe keys
const invalid: OAuthIcon = "definitely-not-a-real-lobe-icon-key-zzz";

void [lobe, http, https, data, invalid];
`;

  try {
    writeFileSync(fixturePath, fixtureSource);
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "x",
        "tsc",
        "--ignoreConfig",
        "--noEmit",
        "--skipLibCheck",
        "--module",
        "Preserve",
        "--moduleResolution",
        "Bundler",
        "--target",
        "ESNext",
        fixturePath,
      ],
      cwd: packagePath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode, `${result.stdout.toString()}${result.stderr.toString()}`).toBe(0);
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});
