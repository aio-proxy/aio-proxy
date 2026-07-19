import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OAuthQuotaCapabilityUnavailableError } from "../plugin-quota";
import { createServerState } from "./index";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("exposes internal OAuth quota operations on pathless non-OAuth server state", async () => {
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: tempHome(),
  });

  try {
    expect(typeof state.oauthQuota.read).toBe("function");
    expect(typeof state.oauthQuota.reset).toBe("function");
    await expect(state.oauthQuota.read("missing", new AbortController().signal)).rejects.toBeInstanceOf(
      OAuthQuotaCapabilityUnavailableError,
    );
    await expect(state.oauthQuota.reset("missing", new AbortController().signal)).rejects.toBeInstanceOf(
      OAuthQuotaCapabilityUnavailableError,
    );
  } finally {
    state.close();
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-oauth-quota-state-"));
  homes.push(home);
  return home;
}
