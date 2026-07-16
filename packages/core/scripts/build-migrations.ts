import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type MigrationMetadata = readonly [file: string, sha256: string];

const MANIFEST_METADATA = /const migrationMetadata = (\[[\s\S]*?\n\]) as const;/;
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

function existingMetadata(manifest: string): readonly MigrationMetadata[] {
  const match = MANIFEST_METADATA.exec(manifest);
  if (match?.[1] === undefined) return [];
  const value: unknown = JSON.parse(match[1].replace(/,\n\]$/, "\n]"));
  if (!Array.isArray(value)) throw new Error("Migration manifest metadata is invalid");
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error("Migration manifest metadata is invalid");
    }
    return [entry[0], entry[1]] as const;
  });
}

function renderManifest(metadata: readonly MigrationMetadata[]): string {
  const imports = metadata
    .map(([file], index) => `import migration${index.toString().padStart(4, "0")}Sql from "./migrations/${file}?raw";`)
    .join("\n");
  const entries = metadata
    .map(([file, sha256]) => `  [${JSON.stringify(file)}, ${JSON.stringify(sha256)}],`)
    .join("\n");
  const sql = metadata
    .map((_, index) => `  [migrationMetadata[${index}], migration${index.toString().padStart(4, "0")}Sql],`)
    .join("\n");
  return `${imports}

export type Migration = {
  readonly version: number;
  readonly file: string;
  readonly sha256: string;
  readonly sql: string;
};

const migrationMetadata = [
${entries}
] as const;

const migrationSql = [
${sql}
] as const;

export const MIGRATIONS: readonly Migration[] = migrationSql.map(([metadata, migration], index) => ({
  version: index + 1,
  file: metadata[0],
  sha256: metadata[1],
  sql: migration,
}));

export const COMPILED_SCHEMA_VERSION = MIGRATIONS.length;
`;
}

export async function buildMigrationsManifest(
  root: string,
  options: { readonly check?: boolean } = {},
): Promise<{
  readonly changed: boolean;
  readonly migrations: number;
}> {
  const migrationsDir = join(root, "src", "db", "migrations");
  const manifestPath = join(root, "src", "db", "migrations.manifest.ts");
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const metadata: MigrationMetadata[] = [];
  for (const [index, file] of files.entries()) {
    const match = MIGRATION_FILE.exec(file);
    if (match?.[1] !== index.toString().padStart(4, "0")) {
      throw new Error(`Migration ${file} must use the next append-only sequence ${index.toString().padStart(4, "0")}`);
    }
    const sql = await readFile(join(migrationsDir, file));
    metadata.push([file, createHash("sha256").update(sql).digest("hex")]);
  }

  const current = await readFile(manifestPath, "utf8").catch(() => "");
  const previous = existingMetadata(current);
  for (const [index, [file, sha256]] of previous.entries()) {
    const next = metadata[index];
    if (next?.[0] !== file || next[1] !== sha256) {
      throw new Error(`Historical migration ${file} was modified; migrations are append-only`);
    }
  }
  if (metadata.length < previous.length) {
    throw new Error("Historical migrations were removed; migrations are append-only");
  }

  const manifest = renderManifest(metadata);
  if (manifest === current) return { changed: false, migrations: metadata.length };
  if (options.check === true) {
    throw new Error("Migration manifest is stale; run `bun run build:migrations`");
  }
  await writeFile(manifestPath, manifest);
  return { changed: true, migrations: metadata.length };
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = await buildMigrationsManifest(root, { check: process.argv.slice(2).includes("--check") });
    console.log(`${result.changed ? "Updated" : "Verified"} ${result.migrations} append-only migrations.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
