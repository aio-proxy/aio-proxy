import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const coreDist = join(repoRoot, "packages/core/dist");

function artifactFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return artifactFiles(path);
    return entry.name.endsWith(".js") || entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

test("built package entry resolves moved plugin directories", () => {
  const build = Bun.spawnSync([process.execPath, "run", "--filter", "@aio-proxy/core", "build"], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(build.exitCode).toBe(0);

  const unresolved = artifactFiles(coreDist).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/(?:from|import\()\s*["']([^"']+)["']/gu)]
      .map((match) => match[1])
      .filter((specifier) => /\/(?:account-login|repository|loader)(?:\.js)?$/u.test(specifier))
      .map((specifier) => `${file.slice(coreDist.length + 1)}: ${specifier}`);
  });
  expect(unresolved).toEqual([]);

  const smoke = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      'const core = await import("./packages/core/dist/index.js"); for (const name of ["loginOAuthAccount", "loadPluginRegistry", "createPluginRepository"]) if (typeof core[name] !== "function") throw new Error("missing " + name);',
    ],
    { cwd: repoRoot, stderr: "pipe", stdout: "pipe" },
  );
  expect(smoke.stderr.toString()).toBe("");
  expect(smoke.exitCode).toBe(0);
}, 30_000);
