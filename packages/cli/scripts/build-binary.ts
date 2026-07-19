import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { virtualCompiledEntry } from "./generate-compiled-entry";

const targets = [
  { suffix: "darwin-arm64", target: "bun-darwin-arm64" },
  { suffix: "darwin-x64", target: "bun-darwin-x64" },
  { suffix: "linux-x64", target: "bun-linux-x64" },
  { suffix: "linux-arm64", target: "bun-linux-arm64" },
] as const;

const only = process.argv[2];
const selected = only === undefined ? targets : targets.filter((t) => t.suffix === only);
if (selected.length === 0) {
  console.error(`Unknown target "${only}". Valid: ${targets.map((t) => t.suffix).join(", ")}`);
  process.exit(1);
}

const rootDir = join(import.meta.dir, "..", "..", "..");

const entry = virtualCompiledEntry();
for (const { suffix, target } of selected) {
  const binDir = join(rootDir, "npm", `cli-${suffix}`, "bin");
  mkdirSync(binDir, { recursive: true });
  const outfile = join(binDir, "aio-proxy");
  const build = await Bun.build({
    entrypoints: [entry.entrypoint],
    files: entry.files,
    compile: {
      target,
      outfile,
    },
  });
  if (!build.success) {
    for (const log of build.logs) {
      console.error(log);
    }
    console.error(`bun build --compile failed for ${target}`);
    process.exit(1);
  }
  console.log(`${suffix}: ${outfile}`);
}
