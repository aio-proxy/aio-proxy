import baselineSql from "./migrations/0000_busy_hedge_knight.sql?raw";

export type Migration = {
  readonly version: number;
  readonly file: string;
  readonly sha256: string;
  readonly sql: string;
};

const migrationSql = [
  [["0000_busy_hedge_knight.sql", "15813487f2b722358332d79e093025352a1399111e0983b8015fe8b8884f2681"], baselineSql],
] as const;

export const MIGRATIONS: readonly Migration[] = migrationSql.map(([metadata, sql], index) => ({
  version: index + 1,
  file: metadata[0],
  sha256: metadata[1],
  sql,
}));

export const COMPILED_SCHEMA_VERSION = MIGRATIONS.length;
