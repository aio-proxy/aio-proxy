// AUTO-GENERATED - do not edit. Regenerate via `bun run build:migrations`.
import sql0 from "./migrations/0000_auth.sql" with { type: "text" };

export type Migration = {
  readonly version: number;
  readonly file: string;
  readonly sha256: string;
  readonly sql: string;
};

export const COMPILED_SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    file: "0000_auth.sql",
    sha256: "eb1e949c83a040008245b395c29aa2dad4eee7786bae8875660094e2f8cf9ab0",
    sql: sql0,
  },
];
