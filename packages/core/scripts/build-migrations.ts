import { join } from "node:path";
import { $ } from "bun";
import { writeMigrationManifestFromJournal } from "./migration-manifest";

const root = join(import.meta.dir, "..");

await $`bunx drizzle-kit generate`.cwd(root);

const result = await writeMigrationManifestFromJournal(root);

console.log(`${result.changed ? "Updated" : "Verified"} ${result.migrations} migrations.`);
