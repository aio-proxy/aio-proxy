import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateCompiledEntry } from "./generate-compiled-entry";

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

const packageDir = join(import.meta.dir, "..");
const outDir = join(packageDir, "dist-bin");
mkdirSync(outDir, { recursive: true });

const entry = generateCompiledEntry();
try {
  for (const { suffix, target } of selected) {
    const outfile = join(outDir, `aio-proxy-${suffix}`);
    const build = Bun.spawnSync(
      [process.execPath, "build", "--compile", `--target=${target}`, entry, `--outfile=${outfile}`],
      { cwd: packageDir, stderr: "inherit", stdout: "inherit" },
    );
    if (build.exitCode !== 0) {
      console.error(`bun build --compile failed for ${target}`);
      process.exit(build.exitCode ?? 1);
    }
    console.log(outfile);
  }
} finally {
  rmSync(entry, { force: true });
}
