import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const providerSchemasDist = join(import.meta.dir, "../dist");

test("explicit dependency build supports source start from a clean provider dist", async () => {
  const providerPackage = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8"));
  const cliPackage = JSON.parse(await readFile(join(repositoryRoot, "packages/cli/package.json"), "utf8"));
  const turbo = JSON.parse(await readFile(join(repositoryRoot, "turbo.json"), "utf8"));

  expect(providerPackage.scripts.dev).toBe("rslib --watch --no-clean");
  expect(cliPackage.scripts.start).toBe("bun src/main.ts serve");
  expect(cliPackage.scripts["build:binary"]).toStartWith("bun run --filter @aio-proxy/provider-schemas build && ");
  expect(turbo.tasks.dev.dependsOn).toContain("^build");
  expect(turbo.tasks["@aio-proxy/cli#serve:dev"].dependsOn).toContain("^build");

  rmSync(providerSchemasDist, { recursive: true, force: true });
  const dependencyBuild = Bun.spawnSync(["bun", "run", "--filter", "@aio-proxy/provider-schemas", "build"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(dependencyBuild.exitCode, `${dependencyBuild.stdout}\n${dependencyBuild.stderr}`).toBe(0);
  expect(existsSync(join(providerSchemasDist, "index.js"))).toBe(true);

  const start = Bun.spawn(["bun", "run", "--filter", "@aio-proxy/cli", "start", "--help"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => start.kill(), 120_000);
  const exitCode = await start.exited;
  clearTimeout(timeout);
  const output = `${await new Response(start.stdout).text()}\n${await new Response(start.stderr).text()}`;

  expect(exitCode, output).toBe(0);
  expect(output).not.toContain("Rslib");

  const resolution = Bun.spawnSync(
    [
      "bun",
      "-e",
      'import("@aio-proxy/provider-schemas").then(({ providerOptionsSchema }) => console.log(providerOptionsSchema("@ai-sdk/openai-compatible")?.packageVersion))',
    ],
    { cwd: join(repositoryRoot, "packages/server"), stdout: "pipe", stderr: "pipe" },
  );
  expect(resolution.exitCode, resolution.stderr.toString()).toBe(0);
  const packageVersion = resolution.stdout.toString().trim();
  expect(packageVersion.length).toBeGreaterThan(0);
  expect(packageVersion).not.toBe("undefined");
}, 180_000);
