import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@aio-proxy/core/db";
import { Auth, AuthCasBusyError, StaleProviderGenerationError } from "../src";

type IsolatedHome = {
  readonly home: string;
  readonly previousHome: string | undefined;
};

const homes: string[] = [];
const ENV_AIO_PROXY_HOME = "AIO_PROXY_HOME";
const busyLockChildPath = fileURLToPath(
  new URL("./busy-lock-child.ts", import.meta.url),
);

afterEach(() => {
  const previousHome = homes.pop();
  if (previousHome === undefined) {
    delete process.env[ENV_AIO_PROXY_HOME];
  } else {
    process.env[ENV_AIO_PROXY_HOME] = previousHome;
  }
});

function isolateHome(): IsolatedHome {
  const previousHome = process.env[ENV_AIO_PROXY_HOME];
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-auth-"));
  process.env[ENV_AIO_PROXY_HOME] = home;
  homes.push(previousHome);
  return { home, previousHome };
}

function dbPath(home: string): string {
  return join(home, "aio-proxy.db");
}

function firstPragmaValue(record: unknown): string | number {
  if (typeof record !== "object" || record === null) {
    throw new TypeError("expected pragma row object");
  }

  const value = Object.values(record).at(0);
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }

  throw new TypeError("expected string or number pragma value");
}

function runChildLock(home: string): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  const child = Bun.spawn([process.execPath, busyLockChildPath, "1000"], {
    cwd: process.cwd(),
    env: { ...process.env, AIO_PROXY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return child;
}

async function waitForLocked(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (!output.includes("locked")) {
    const chunk = await reader.read();
    if (chunk.done) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`lock child exited before lock acquisition: ${stderr}`);
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
}

test("Given isolated auth store When two provider rows are set and one is deleted Then remaining rows round-trip and db mode is 0600", () => {
  const { home } = isolateHome();
  const defaultPayload = {
    access_token: "ghu_default",
    account: "octo-default",
    expiresAt: 1_899_000_000_000,
  };
  const workPayload = {
    access_token: "ghu_work",
    account: "octo-work",
    expiresAt: 1_899_000_001_000,
  };

  Auth.set("github-copilot", "default", defaultPayload, "fingerprint-default");
  Auth.set("github-copilot", "work", workPayload, "fingerprint-work");
  Auth.del("github-copilot", "default");

  expect(Auth.get("github-copilot", "default")).toBeNull();
  expect(Auth.get("github-copilot", "work")).toEqual({
    vendor: "github-copilot",
    providerId: "work",
    accountFingerprint: "fingerprint-work",
    payload: workPayload,
  });

  if (process.platform !== "win32") {
    expect(statSync(dbPath(home)).mode & 0o777).toBe(0o600);
  }
});

test("Given token payloads When auth rows are listed Then summaries redact payload bytes and expose account labels", () => {
  isolateHome();

  Auth.set(
    "github-copilot",
    "default",
    {
      access_token: "Bearer ghu_secret_access",
      refresh_token: "ghu_secret_refresh",
      account: "octocat",
      expiresAt: 1_899_000_000_000,
    },
    "fingerprint-default",
  );

  const summaries = Auth.list();
  const serialized = JSON.stringify(summaries);

  expect(summaries).toEqual([
    {
      vendor: "github-copilot",
      providerId: "default",
      hasToken: true,
      expiresAt: 1_899_000_000_000,
      accountLabel: "octocat",
    },
  ]);
  expect(serialized).not.toContain("payload");
  expect(serialized).not.toMatch(
    /access_token|refresh_token|Bearer|ghu_[A-Za-z0-9_]+/,
  );
});

test("Given an initialized auth database When PRAGMA and table metadata are inspected Then WAL busy timeout and account_fingerprint exist", () => {
  isolateHome();
  Auth.set(
    "github-copilot",
    "default",
    { account: "octocat" },
    "fingerprint-default",
  );

  const handle = openDb({ readonly: true });
  try {
    const journalMode = firstPragmaValue(
      handle.sqlite.query("PRAGMA journal_mode").get(),
    );
    const busyTimeout = firstPragmaValue(
      handle.sqlite.query("PRAGMA busy_timeout").get(),
    );
    const tableInfo = JSON.stringify(
      handle.sqlite.query("PRAGMA table_info(auth)").all(),
    );

    expect(journalMode).toBe("wal");
    expect(busyTimeout).toBe(5_000);
    expect(tableInfo).toContain("account_fingerprint");
  } finally {
    handle.close();
  }
});

test("Given 50 CAS writers with the same expected fingerprint When each attempts a write Then exactly one succeeds and the rest are stale", () => {
  isolateHome();
  Auth.set("github-copilot", "default", { generation: "seed" }, "seed");

  const outcomes = Array.from({ length: 50 }, (_, index) => {
    try {
      Auth.cas("github-copilot", "default", "seed", () => ({
        payload: { generation: `winner-${index}` },
        accountFingerprint: `winner-${index}`,
      }));
      return "success";
    } catch (error) {
      if (error instanceof StaleProviderGenerationError) {
        return "stale";
      }
      throw error;
    }
  });

  expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === "stale")).toHaveLength(49);
  expect(Auth.get("github-copilot", "default")?.accountFingerprint).toMatch(
    /^winner-/,
  );
});

test("Given another process holds a write transaction When CAS begins immediate Then busy maps to AuthCasBusyError and timeout is restored", async () => {
  const { home } = isolateHome();
  mkdirSync(home, { recursive: true });
  Auth.set("github-copilot", "default", { generation: "seed" }, "seed");

  const child = runChildLock(home);
  await waitForLocked(child);

  try {
    expect(() =>
      Auth.cas("github-copilot", "default", "seed", () => ({
        payload: { generation: "next" },
        accountFingerprint: "next",
      })),
    ).toThrow(AuthCasBusyError);

    const handle = openDb({ readonly: true });
    try {
      expect(
        firstPragmaValue(handle.sqlite.query("PRAGMA busy_timeout").get()),
      ).toBe(5_000);
    } finally {
      handle.close();
    }
  } finally {
    child.kill();
    await child.exited;
  }
});
