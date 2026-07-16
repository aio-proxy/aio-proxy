import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dependencySections = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

const unsupportedDependencyProtocols = ["catalog:", "workspace:"] as const;

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type CommandRunner = (command: readonly string[], cwd?: string) => CommandResult;

export interface PackedPackageIdentity {
  readonly integrity: string;
  readonly name: string;
  readonly version: string;
}

const commandOutput = (result: CommandResult): string => `${result.stdout}${result.stderr}`;

const run: CommandRunner = (command, cwd) => {
  const result = Bun.spawnSync(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const runChecked = (command: readonly string[], cwd?: string): CommandResult => {
  const result = run(command, cwd);
  if (result.exitCode !== 0) throw commandFailure(command, result);
  return result;
};

const commandFailure = (command: readonly string[], result: CommandResult): Error =>
  new Error(`Command failed (${command.join(" ")}):\n${commandOutput(result)}`);

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
  const extracted = runChecked(["tar", "-xOf", tarball, "package/package.json"]);
  try {
    return JSON.parse(extracted.stdout);
  } catch (error) {
    throw new Error(`Packed package manifest is not valid JSON: ${tarball}`, { cause: error });
  }
};

export const getPackedPackageIdentity = (tarball: string): PackedPackageIdentity => {
  const manifest = readPackedManifest(tarball);
  assertPublishableManifest(manifest);
  const packedManifest = manifest as Record<string, unknown>;
  const name = packedManifest.name;
  const version = packedManifest.version;
  if (typeof name !== "string" || name.length === 0 || typeof version !== "string" || version.length === 0) {
    throw new Error(`Packed package manifest must contain a non-empty name and version: ${tarball}`);
  }
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  return { integrity, name, version };
};

export const packPublicPackage = (packageDir: string, destination: string): string => {
  const absolutePackageDir = resolve(packageDir);
  const absoluteDestination = resolve(destination);
  mkdirSync(absoluteDestination, { recursive: true });
  runChecked([process.execPath, "pm", "pack", "--destination", absoluteDestination], absolutePackageDir);

  const tarballs = readdirSync(absoluteDestination)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(absoluteDestination, name));
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one packed tarball in ${absoluteDestination}, found ${tarballs.length}`);
  }

  const tarball = tarballs[0];
  if (tarball === undefined) throw new Error(`Packed tarball missing from ${absoluteDestination}`);
  getPackedPackageIdentity(tarball);
  return tarball;
};

type RegistryArtifact = "absent" | "matching";

const inspectRegistryArtifact = (identity: PackedPackageIdentity, execute: CommandRunner): RegistryArtifact => {
  const spec = `${identity.name}@${identity.version}`;
  const command = ["npm", "view", spec, "--json"] as const;
  const result = execute(command);
  if (result.exitCode !== 0) {
    if (/\bE404\b|\b404\b|not found/i.test(commandOutput(result))) return "absent";
    throw commandFailure(command, result);
  }

  let published: unknown;
  try {
    published = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Registry metadata is not valid JSON for ${spec}`, { cause: error });
  }
  const registryManifest =
    published !== null && typeof published === "object" && !Array.isArray(published)
      ? (published as Record<string, unknown>)
      : {};
  const publishedName = registryManifest.name;
  const publishedVersion = registryManifest.version;
  const dist = registryManifest.dist;
  const publishedIntegrity =
    dist !== null && typeof dist === "object" && !Array.isArray(dist)
      ? (dist as Record<string, unknown>).integrity
      : undefined;
  if (
    publishedName !== identity.name ||
    publishedVersion !== identity.version ||
    publishedIntegrity !== identity.integrity
  ) {
    throw new Error(`Registry artifact identity mismatch for ${spec}`);
  }
  return "matching";
};

export const publishVerifiedTarball = (
  tarball: string,
  execute: CommandRunner = run,
): "already-published" | "published" => {
  const identity = getPackedPackageIdentity(tarball);
  if (inspectRegistryArtifact(identity, execute) === "matching") return "already-published";

  const command = ["npm", "publish", tarball, "--access", "public"] as const;
  const result = execute(command);
  if (result.exitCode === 0) {
    process.stdout.write(commandOutput(result));
    return "published";
  }

  const publishError = commandFailure(command, result);
  try {
    if (inspectRegistryArtifact(identity, execute) === "matching") return "already-published";
  } catch (verificationError) {
    if (verificationError instanceof Error && /artifact identity mismatch/.test(verificationError.message)) {
      throw verificationError;
    }
  }
  throw publishError;
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
    for (const tarball of tarballs) publishVerifiedTarball(tarball);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
