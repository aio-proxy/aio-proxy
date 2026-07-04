import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");
const distBin = join(rootDir, "packages", "cli", "dist-bin");

const platformPackages = ["cli-darwin-arm64", "cli-darwin-x64", "cli-linux-x64", "cli-linux-arm64"] as const;

const readPackage = async (dir: string) => {
  const pkg = (await Bun.file(join(dir, "package.json")).json()) as { name: string; version: string };
  return pkg;
};

const isPublished = (name: string, version: string): boolean => {
  const view = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], { stderr: "ignore", stdout: "ignore" });
  return view.exitCode === 0;
};

const publish = (dir: string) => {
  const result = Bun.spawnSync([process.execPath, "publish", "--access", "public"], {
    cwd: dir,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`bun publish failed in ${dir}`);
    process.exit(result.exitCode ?? 1);
  }
};

for (const suffix of platformPackages) {
  const binary = join(distBin, `aio-proxy-${suffix.replace(/^cli-/u, "")}`);
  if (!existsSync(binary)) {
    console.error(`Missing binary: ${binary}. Run build:binary first.`);
    process.exit(1);
  }
  const binDir = join(rootDir, "npm", suffix, "bin");
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, "aio-proxy");
  copyFileSync(binary, target);
  chmodSync(target, 0o755);
}

const dirs = [...platformPackages.map((p) => join(rootDir, "npm", p)), join(rootDir, "npm", "aio-proxy")];
for (const dir of dirs) {
  const pkg = await readPackage(dir);
  if (isPublished(pkg.name, pkg.version)) {
    console.log(`skip ${pkg.name}@${pkg.version} (already published)`);
    continue;
  }
  console.log(`publish ${pkg.name}@${pkg.version}`);
  publish(dir);
}
