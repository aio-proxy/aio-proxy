import { afterEach, expect, test } from "bun:test";
import { zod } from "@aio-proxy/plugin-sdk";
import { OAuthQuotaReadError } from "./errors";
import { createOAuthQuotaReader } from "./read";
import { cleanupQuotaFixtures, createQuotaFixture, PROVIDER_ID } from "./test-support";

afterEach(cleanupQuotaFixtures);

async function capturedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected operation to reject");
}

test("redacts credentials discovered through a successful refresh before a later plugin failure", async () => {
  const refreshedSecret = "refreshed-credential-secret";
  const fixture = createQuotaFixture({
    read: async ({ credentials }) => {
      const current = await credentials.read();
      const refreshed = await credentials.refresh(current.revision, async (exchangeCurrent) => {
        expect(exchangeCurrent).toEqual(current);
        return { value: { token: refreshedSecret } };
      });
      expect(refreshed).toMatchObject({
        status: "updated",
        snapshot: { value: { token: refreshedSecret } },
      });
      const failure = new Error(`message ${refreshedSecret}`);
      failure.name = `name ${refreshedSecret}`;
      failure.stack = `stack ${refreshedSecret}`;
      throw failure;
    },
  });

  const error = await capturedError(
    createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, new AbortController().signal),
  );

  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(error).not.toHaveProperty("cause");
  expect(fixture.logs).toHaveLength(1);
  expect(JSON.stringify(fixture.logs)).not.toContain(refreshedSecret);
  expect(fixture.repository.readAccount(PROVIDER_ID)?.credential).toEqual({ token: refreshedSecret });
});

test("redacts initial credential, account, and plugin secrets from error names", async () => {
  const fixture = createQuotaFixture({
    read: async () => {
      const failure = new Error("safe message");
      failure.name = "credential-secret account-secret plugin-secret";
      throw failure;
    },
  });

  const error = await capturedError(
    createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, new AbortController().signal),
  );

  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(JSON.stringify(fixture.logs)).not.toMatch(/credential-secret|account-secret|plugin-secret/u);
});

test.each([
  "Map",
  "non-enumerable field",
] as const)("redacts a Zod-derived secret stored only in a %s", async (storage) => {
  const derivedSecret = `derived-${storage.replaceAll(" ", "-")}-secret`;
  const credentials = zod.object({ token: zod.string() }).transform(() => {
    if (storage === "Map") return new Map([["derived", derivedSecret]]);
    return Object.defineProperty({}, "derived", { value: derivedSecret, enumerable: false });
  });
  const fixture = createQuotaFixture({
    credentials,
    read: async ({ credentials: port }) => {
      await port.read();
      const failure = new Error(`message ${derivedSecret}`);
      failure.name = `name ${derivedSecret}`;
      failure.stack = `stack ${derivedSecret}`;
      throw failure;
    },
  });

  const error = await capturedError(
    createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, new AbortController().signal),
  );

  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(fixture.logs).toHaveLength(1);
  expect(JSON.stringify(fixture.logs)).not.toContain(derivedSecret);
});

test("preserves the stable quota error when the failure log sink throws", async () => {
  const fixture = createQuotaFixture({
    loggerFailure: true,
    read: async () => {
      throw new Error("plugin failed");
    },
  });

  const error = await capturedError(
    createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, new AbortController().signal),
  );

  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(error).toMatchObject({
    name: "OAuthQuotaReadError",
    message: "OAuth quota read failed",
    code: "OAUTH_QUOTA_READ_FAILED",
  });
  expect(error).not.toHaveProperty("cause");
});
