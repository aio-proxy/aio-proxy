import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

const hostSuffix = (): string => {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined;
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (platform === undefined || architecture === undefined) {
    throw new Error(`Unsupported binary smoke platform: ${process.platform}-${process.arch}`);
  }
  return `${platform}-${architecture}`;
};

test("compiled binary lists all embedded OAuth plugins outside the workspace", () => {
  const suffix = hostSuffix();
  const build = Bun.spawnSync([process.execPath, "packages/cli/scripts/build-binary.ts", suffix], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(`${build.stdout.toString()}${build.stderr.toString()}`).toContain(`${suffix}:`);
  expect(build.exitCode).toBe(0);

  const home = mkdtempSync(join(tmpdir(), "aio-proxy-binary-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "aio-proxy-binary-cwd-"));
  try {
    const result = Bun.spawnSync([join(repoRoot, "npm", `cli-${suffix}`, "bin", "aio-proxy"), "plugin", "list"], {
      cwd,
      env: {
        ...process.env,
        AIO_PROXY_HOME: home,
        AIO_PROXY_LANG: undefined,
        LANG: "en_US.UTF-8",
        LANGUAGE: undefined,
        LC_ALL: undefined,
        LC_MESSAGES: undefined,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdout = result.stdout.toString();
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("@aio-proxy/plugin-github-copilot");
    expect(stdout).toContain("@aio-proxy/plugin-openai-chatgpt");
    expect(stdout).toContain("@aio-proxy/plugin-google-antigravity");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);
