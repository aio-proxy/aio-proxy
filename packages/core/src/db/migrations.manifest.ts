import { createHash } from "node:crypto";
import authSql from "./migrations/0000_auth.sql?raw";
import usageSql from "./migrations/0001_usage.sql?raw";
import requestLogSql from "./migrations/0002_request_log.sql?raw";
import requestLogIndexesSql from "./migrations/0003_request_log_indexes.sql?raw";
import oauthPluginsSql from "./migrations/0004_oauth_plugins.sql?raw";

export type Migration = {
  readonly version: number;
  readonly file: string;
  readonly sha256: string;
  readonly sql: string;
};

const migrationSql = [
  ["0000_auth.sql", authSql],
  ["0001_usage.sql", usageSql],
  ["0002_request_log.sql", requestLogSql],
  ["0003_request_log_indexes.sql", requestLogIndexesSql],
  ["0004_oauth_plugins.sql", oauthPluginsSql],
] as const;

export const MIGRATIONS: readonly Migration[] = migrationSql.map(([file, sql], index) => ({
  version: index + 1,
  file,
  sha256: createHash("sha256").update(sql).digest("hex"),
  sql,
}));

export const COMPILED_SCHEMA_VERSION = MIGRATIONS.length;
