import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMigrationsManifest } from "../scripts/build-migrations";
import { MigrationHashMismatchError } from "../src/error";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("builds an idempotent append-only migration manifest without Drizzle metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "aio-proxy-migrations-build-"));
  roots.push(root);
  const migrations = join(root, "src", "db", "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, "0000_auth.sql"), "CREATE TABLE auth (id text);\n");
  writeFileSync(join(migrations, "0001_usage.sql"), "CREATE TABLE usage (id text);\n");

  await expect(buildMigrationsManifest(root)).resolves.toEqual({ changed: true, migrations: 2 });
  const manifestPath = join(root, "src", "db", "migrations.manifest.ts");
  const first = readFileSync(manifestPath, "utf8");
  expect(first).toContain('["0000_auth.sql", "');
  expect(first).toContain('import migration0001Sql from "./migrations/0001_usage.sql?raw";');
  const second = await buildMigrationsManifest(root);
  expect(second).toEqual({ changed: false, migrations: 2 });
  expect(readFileSync(manifestPath, "utf8")).toBe(first);

  writeFileSync(join(migrations, "0000_auth.sql"), "CREATE TABLE rewritten (id text);\n");
  await expect(buildMigrationsManifest(root)).rejects.toThrow("Historical migration 0000_auth.sql was modified");

  writeFileSync(join(migrations, "0000_auth.sql"), "CREATE TABLE auth (id text);\n");
  writeFileSync(join(migrations, "0002_request_log.sql"), "CREATE TABLE request_log (id text);\n");
  await expect(buildMigrationsManifest(root)).resolves.toEqual({ changed: true, migrations: 3 });
  expect(readFileSync(manifestPath, "utf8")).toContain("0002_request_log.sql");
});

test("migration hash mismatch directs historical SQL restoration before adding a new migration", () => {
  const error = new MigrationHashMismatchError(
    {
      version: 6,
      file: "0005_drop_legacy_auth.sql",
      sha256: "expected-hash",
      sql: "DROP TABLE IF EXISTS auth;",
    },
    "actual-hash",
  );

  expect(error.name).toBe("MigrationHashMismatchError");
  expect(error.migration.file).toBe("0005_drop_legacy_auth.sql");
  expect(error.actualSha256).toBe("actual-hash");
  expect(error.message).toContain("Restore historical migration 0005_drop_legacy_auth.sql");
  expect(error.message).toContain("add the next append-only migration, then run `bun run build:migrations`");
  expect(error.message).not.toContain("regenerate migrations and the manifest");
});
