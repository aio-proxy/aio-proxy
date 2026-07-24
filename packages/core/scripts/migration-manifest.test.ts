import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeMigrationManifestFromJournal } from "./migration-manifest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes an idempotent AST manifest in Drizzle journal order", async () => {
  const root = temporaryRoot();
  await writeMigration(root, "0001_second", "SELECT 2;\n");
  await writeMigration(root, "0000_first", "SELECT 1;\n");
  await writeJournal(root, ["0001_second", "0000_first"]);

  const first = await writeMigrationManifestFromJournal(root);
  const manifestPath = join(root, "src/db/migrations.manifest.ts");
  const source = await Bun.file(manifestPath).text();

  expect(first).toEqual({ changed: true, migrations: 2 });
  expect(source.indexOf("0001_second.sql?raw")).toBeLessThan(source.indexOf("0000_first.sql?raw"));
  expect(source).toContain(`sha256: "${sha256("SELECT 2;\n")}"`);
  expect(source).toContain("version: 1");
  expect(source).toContain("version: 2");
  expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();

  await expect(writeMigrationManifestFromJournal(root)).resolves.toEqual({ changed: false, migrations: 2 });
}, 15_000);

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aio-proxy-migrations-"));
  roots.push(root);
  mkdirSync(join(root, "src/db/migrations/meta"), { recursive: true });
  return root;
}

async function writeJournal(root: string, tags: readonly string[]): Promise<void> {
  await Bun.write(
    join(root, "src/db/migrations/meta/_journal.json"),
    JSON.stringify({ entries: tags.map((tag) => ({ tag })) }),
  );
}

async function writeMigration(root: string, tag: string, sql: string): Promise<void> {
  await Bun.write(join(root, `src/db/migrations/${tag}.sql`), sql);
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}
