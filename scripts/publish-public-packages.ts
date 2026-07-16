import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dependencySections = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

const unsupportedDependencyProtocols = ["catalog:", "workspace:"] as const;

const commandOutput = (result: Bun.SpawnSyncReturns<Uint8Array>): string =>
  `${result.stdout.toString()}${result.stderr.toString()}`;

const run = (command: readonly string[], cwd?: string): Bun.SpawnSyncReturns<Uint8Array> => {
  const result = Bun.spawnSync(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${command.join(" ")}):\n${commandOutput(result)}`);
  }
  return result;
};

const visitDependencySections = (value: unknown, path: readonly string[] = []): void => {
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (dependencySections.has(key)) {
      if (child === null || typeof child !== "object") continue;
      for (const [dependency, version] of Object.entries(child)) {
        if (
          typeof version === "string" &&
          unsupportedDependencyProtocols.some((protocol) => version.startsWith(protocol))
        ) {
          throw new Error(`unsupported dependency protocol in ${[...childPath, dependency].join(".")}: ${version}`);
        }
      }
    }
    visitDependencySections(child, childPath);
  }
};

export const assertPublishableManifest = (manifest: unknown): void => {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("packed package manifest must be an object");
  }
  visitDependencySections(manifest);
};

const readPackedManifest = (tarball: string): unknown => {
  const extracted = run(["tar", "-xOf", tarball, "package/package.json"]);
  try {
    return JSON.parse(extracted.stdout.toString());
  } catch (error) {
    throw new Error(`Packed package manifest is not valid JSON: ${tarball}`, { cause: error });
  }
};

export const packPublicPackage = (packageDir: string, destination: string): string => {
  const absolutePackageDir = resolve(packageDir);
  const absoluteDestination = resolve(destination);
  mkdirSync(absoluteDestination, { recursive: true });
  run([process.execPath, "pm", "pack", "--destination", absoluteDestination], absolutePackageDir);

  const tarballs = readdirSync(absoluteDestination)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(absoluteDestination, name));
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one packed tarball in ${absoluteDestination}, found ${tarballs.length}`);
  }

  const tarball = tarballs[0];
  if (tarball === undefined) throw new Error(`Packed tarball missing from ${absoluteDestination}`);
  assertPublishableManifest(readPackedManifest(tarball));
  return tarball;
};

const publishTarball = (tarball: string): void => {
  const result = run(["npm", "publish", tarball, "--access", "public"]);
  process.stdout.write(commandOutput(result));
};

const repoRoot = resolve(import.meta.dir, "..");
const publicPackageDirs = [
  "packages/plugin-sdk",
  "npm/cli-darwin-arm64",
  "npm/cli-darwin-x64",
  "npm/cli-linux-arm64",
  "npm/cli-linux-x64",
  "npm/aio-proxy",
] as const;

if (import.meta.main) {
  const stagingDir = mkdtempSync(join(tmpdir(), "aio-proxy-public-packages-"));
  try {
    const tarballs = publicPackageDirs.map((packageDir, index) =>
      packPublicPackage(join(repoRoot, packageDir), join(stagingDir, String(index))),
    );
    for (const tarball of tarballs) publishTarball(tarball);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
