import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(
  process.cwd(),
  "packages",
  "core",
  "src",
  "db",
  "migrations",
);
const manifestPath = join(
  process.cwd(),
  "packages",
  "core",
  "src",
  "db",
  "migrations.manifest.ts",
);

const migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();

const imports = migrationFiles
  .map(
    (file, index) =>
      `import sql${index} from "./migrations/${file}" with { type: "text" };`,
  )
  .join("\n");

const rows = migrationFiles
  .map((file, index) => {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    return `  {
    version: ${index + 1},
    file: "${file}",
    sha256: "${sha256}",
    sql: sql${index},
  },`;
  })
  .join("\n");

const manifest = `// AUTO-GENERATED - do not edit. Regenerate via \`bun run build:migrations\`.
${imports}

export type Migration = {
  readonly version: number;
  readonly file: string;
  readonly sha256: string;
  readonly sql: string;
};

export const COMPILED_SCHEMA_VERSION = ${migrationFiles.length};

export const MIGRATIONS: readonly Migration[] = [
${rows}
];
`;

writeFileSync(manifestPath, manifest);
