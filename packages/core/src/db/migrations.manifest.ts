import { createHash } from "node:crypto";

export type Migration = {
  readonly version: number;
  readonly file: string;
  readonly sha256: string;
  readonly sql: string;
};

type GlobOptions = {
  readonly eager: true;
  readonly import: "default";
  readonly query: "?raw";
};

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: GlobOptions): Record<string, T>;
  }
}

const migrationSql = import.meta.glob<string>("./migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
});

export const MIGRATIONS: readonly Migration[] = Object.entries(migrationSql)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, sql], index) => ({
    version: index + 1,
    file: path.split("/").at(-1) ?? path,
    sha256: createHash("sha256").update(sql).digest("hex"),
    sql,
  }));

export const COMPILED_SCHEMA_VERSION = MIGRATIONS.length;
