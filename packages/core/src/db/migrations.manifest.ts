import migration0000Sql from "./migrations/0000_auth.sql?raw";
import migration0001Sql from "./migrations/0001_usage.sql?raw";
import migration0002Sql from "./migrations/0002_request_log.sql?raw";
import migration0003Sql from "./migrations/0003_request_log_indexes.sql?raw";
import migration0004Sql from "./migrations/0004_oauth_plugins.sql?raw";
import migration0005Sql from "./migrations/0005_drop_legacy_auth.sql?raw";

export type Migration = {
  readonly version: number;
  readonly file: string;
  readonly sha256: string;
  readonly sql: string;
};

const migrationMetadata = [
  ["0000_auth.sql", "eb1e949c83a040008245b395c29aa2dad4eee7786bae8875660094e2f8cf9ab0"],
  ["0001_usage.sql", "e46c21709f095efbd32325fec3b78c91c804971594f2ad386e1eaaef7066963c"],
  ["0002_request_log.sql", "b0e6b6d8e83532051951971aa739e610522c4c62230b3b143d01c76ad3c3b21e"],
  ["0003_request_log_indexes.sql", "d94f7fc5b2847bb2b94858feb712ecaa250ad6b08ad0d8018f95d952f2b47cc5"],
  ["0004_oauth_plugins.sql", "414867c4e09ac8348a2c69c8f2e5f87bb9cff94283932462233d9f0c66b4fe41"],
  ["0005_drop_legacy_auth.sql", "ecbdcdd0464d6911a40298b124da72ce14753342ba7ab01db1ed00d81f267c8a"],
] as const;

const migrationSql = [
  [migrationMetadata[0], migration0000Sql],
  [migrationMetadata[1], migration0001Sql],
  [migrationMetadata[2], migration0002Sql],
  [migrationMetadata[3], migration0003Sql],
  [migrationMetadata[4], migration0004Sql],
  [migrationMetadata[5], migration0005Sql],
] as const;

export const MIGRATIONS: readonly Migration[] = migrationSql.map(([metadata, migration], index) => ({
  version: index + 1,
  file: metadata[0],
  sha256: metadata[1],
  sql: migration,
}));

export const COMPILED_SCHEMA_VERSION = MIGRATIONS.length;
