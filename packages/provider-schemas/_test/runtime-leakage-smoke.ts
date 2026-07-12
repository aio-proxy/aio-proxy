import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const providerSchemasDist = join(import.meta.dir, "../dist");
const forbidden =
  /@babel\/parser|typebox|\btar\b|provider-source-cache|provider-schemas-generator|provider-schemas-build|provider-schemas-plugin/iu;

const readTree = async (root: string): Promise<string> => {
  const contents: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) contents.push(await readFile(path, "utf8"));
    }
  };
  await visit(root);
  return contents.join("\n");
};

test("builds runtime artifacts without provider schema build tooling", async () => {
  const providerBuild = Bun.spawnSync(["bun", "run", "--filter", "@aio-proxy/provider-schemas", "build"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(providerBuild.exitCode, `${providerBuild.stdout}\n${providerBuild.stderr}`).toBe(0);

  const cliBundle = join(tmpdir(), `aio-proxy-provider-schema-leakage-${crypto.randomUUID()}.js`);
  try {
    const cliBuild = Bun.spawnSync(
      ["bun", "build", "packages/cli/src/main.ts", "--target=bun", `--outfile=${cliBundle}`],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(cliBuild.exitCode, `${cliBuild.stdout}\n${cliBuild.stderr}`).toBe(0);

    const runtimeSource = `${await readTree(providerSchemasDist)}\n${await readFile(cliBundle, "utf8")}`;
    expect(runtimeSource.match(forbidden)).toBeNull();
  } finally {
    rmSync(cliBundle, { force: true });
  }
});
