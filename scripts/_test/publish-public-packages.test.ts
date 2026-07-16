import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertPublishableManifest,
  type CommandResult,
  getPackedPackageIdentity,
  publishVerifiedTarball,
} from "../publish-public-packages";

for (const dependency of ["catalog:", "workspace:*"]) {
  test(`rejects ${dependency} dependencies from packed manifests`, () => {
    const packageDir = mkdtempSync(join(tmpdir(), "aio-proxy-publish-manifest-"));
    const manifestPath = join(packageDir, "package.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "publish-boundary-test",
        version: "1.0.0",
        dependencies: { zod: dependency },
      }),
    );

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(() => assertPublishableManifest(manifest)).toThrow(/unsupported dependency protocol/);
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });
}

const repoRoot = resolve(import.meta.dir, "../..");

const makeTarball = (): { cleanup(): void; tarball: string } => {
  const packageDir = mkdtempSync(join(tmpdir(), "aio-proxy-publish-tarball-"));
  const packedRoot = join(packageDir, "package");
  mkdirSync(packedRoot);
  writeFileSync(
    join(packedRoot, "package.json"),
    JSON.stringify({ name: "@aio-proxy/release-test", version: "1.2.3" }),
  );
  writeFileSync(join(packedRoot, "index.js"), "export const value = 1;\n");
  const tarball = join(packageDir, "release-test.tgz");
  const packed = Bun.spawnSync(["tar", "-czf", tarball, "package"], { cwd: packageDir });
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  return { cleanup: () => rmSync(packageDir, { recursive: true, force: true }), tarball };
};

test("skips publish only when the registry artifact matches the exact tarball", () => {
  const fixture = makeTarball();
  try {
    const identity = getPackedPackageIdentity(fixture.tarball);
    const commands: string[][] = [];
    const execute = (command: readonly string[]): CommandResult => {
      commands.push([...command]);
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          name: identity.name,
          version: identity.version,
          dist: { integrity: identity.integrity },
        }),
      };
    };

    expect(publishVerifiedTarball(fixture.tarball, execute)).toBe("already-published");
    expect(commands).toEqual([["npm", "view", "@aio-proxy/release-test@1.2.3", "--json"]]);
  } finally {
    fixture.cleanup();
  }
});

test("publishes an absent registry artifact", () => {
  const fixture = makeTarball();
  try {
    const commands: string[][] = [];
    const execute = (command: readonly string[]): CommandResult => {
      commands.push([...command]);
      if (command[1] === "view") return { exitCode: 1, stderr: "npm error code E404", stdout: "" };
      return { exitCode: 0, stderr: "", stdout: "+ @aio-proxy/release-test@1.2.3\n" };
    };

    expect(publishVerifiedTarball(fixture.tarball, execute)).toBe("published");
    expect(commands.at(-1)).toEqual(["npm", "publish", fixture.tarball, "--access", "public"]);
  } finally {
    fixture.cleanup();
  }
});

test("hard fails when an existing registry artifact does not match the tarball", () => {
  const fixture = makeTarball();
  try {
    const execute = (): CommandResult => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        name: "@aio-proxy/release-test",
        version: "1.2.3",
        dist: { integrity: "sha512-not-the-packed-artifact" },
      }),
    });

    expect(() => publishVerifiedTarball(fixture.tarball, execute)).toThrow(/artifact identity mismatch/);
  } finally {
    fixture.cleanup();
  }
});

test("recovers from an already-published race only after registry identity verification", () => {
  const fixture = makeTarball();
  try {
    const identity = getPackedPackageIdentity(fixture.tarball);
    let viewCount = 0;
    const execute = (command: readonly string[]): CommandResult => {
      if (command[1] === "view") {
        viewCount += 1;
        if (viewCount === 1) return { exitCode: 1, stderr: "npm error code E404", stdout: "" };
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ ...identity, dist: { integrity: identity.integrity } }),
        };
      }
      return { exitCode: 1, stderr: "npm error code E409\ncannot publish over existing version", stdout: "" };
    };

    expect(publishVerifiedTarball(fixture.tarball, execute)).toBe("already-published");
  } finally {
    fixture.cleanup();
  }
});

test("does not swallow registry authorization or conflict errors without a matching artifact", () => {
  const fixture = makeTarball();
  try {
    let call = 0;
    const execute = (): CommandResult => {
      call += 1;
      if (call === 1) return { exitCode: 1, stderr: "npm error code E404", stdout: "" };
      if (call === 2) return { exitCode: 1, stderr: "npm error code E403", stdout: "" };
      return { exitCode: 1, stderr: "npm error code E403", stdout: "" };
    };

    expect(() => publishVerifiedTarball(fixture.tarball, execute)).toThrow(/E403/);
  } finally {
    fixture.cleanup();
  }
});

test("release workflow recovers missing npm artifacts before creating the GitHub release", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const eligibility = workflow.indexOf('npm view "$name@$package_version" version');
  const publish = workflow.indexOf("bun scripts/publish-public-packages.ts");
  const createRelease = workflow.indexOf("gh release create");

  expect(eligibility).toBeGreaterThan(-1);
  expect(workflow).not.toContain('if git rev-parse "v$version"');
  expect(publish).toBeGreaterThan(-1);
  expect(createRelease).toBeGreaterThan(publish);
});
