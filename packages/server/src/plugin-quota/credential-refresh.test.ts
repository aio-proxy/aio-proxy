import { type AccountContext, zod } from "@aio-proxy/plugin-sdk";
import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { createOAuthQuotaReader } from "./read";
import { createOAuthQuotaResetter } from "./reset";
import {
  availableQuotaSnapshot,
  capturedQuotaError,
  cleanupQuotaFixtures,
  createQuotaFixture,
  diagnostics,
  PROVIDER_ID,
  quotaSignal,
} from "./test-support";

afterEach(cleanupQuotaFixtures);

async function failedRefresh(context: AccountContext<unknown, unknown>): Promise<never> {
  const current = await context.credentials.read();
  return context.credentials.refresh(current.revision, async () => {
    throw new Error("credential exchange failed");
  }) as Promise<never>;
}

async function successfulRefresh(context: AccountContext<unknown, unknown>, token: string): Promise<void> {
  const current = await context.credentials.read();
  await context.credentials.refresh(current.revision, async () => ({
    value: { token },
    metadata: { label: `label-${token}`, expiresAt: 42 },
  }));
}

test.each(["read", "reset"] as const)(
  "a failed credential refresh during quota %s logs without adding a routing diagnostic or callback",
  async (operation) => {
    const fixture = createQuotaFixture(
      operation === "read"
        ? { read: failedRefresh }
        : { read: async () => availableQuotaSnapshot, reset: failedRefresh },
    );
    const before = fixture.repository.readDiagnostics(PROVIDER_ID);

    if (operation === "read") {
      await capturedQuotaError(createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, quotaSignal()));
    } else {
      await capturedQuotaError(createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()));
    }

    expect(fixture.logs.some(({ code }) => code === "CREDENTIAL_REFRESH_FAILED")).toBe(true);
    expect(fixture.repository.readDiagnostics(PROVIDER_ID)).toEqual(before);
    expect(fixture.changed()).toBe(0);
  },
);

test.each(["read", "reset"] as const)(
  "quota %s credential refresh redacts secrets derived from parsed account options",
  async (operation) => {
    const derivedSecret = Buffer.from("account-secret").toString("base64");
    const refresh = async (context: AccountContext<unknown, unknown>): Promise<never> => {
      expect(context.options).toEqual({ authorization: derivedSecret });
      const current = await context.credentials.read();
      return context.credentials.refresh(current.revision, async () => {
        throw new Error(`credential exchange failed with ${derivedSecret}`);
      }) as Promise<never>;
    };
    const fixture = createQuotaFixture({
      accountOptions: {
        schema: zod
          .object({ region: zod.string(), clientSecret: zod.string() })
          .transform(({ clientSecret }) => ({ authorization: Buffer.from(clientSecret).toString("base64") })),
        form: [{ type: "secret", key: "clientSecret", label: "Client secret" }],
      },
      ...(operation === "read" ? { read: refresh } : { read: async () => availableQuotaSnapshot, reset: refresh }),
    });

    if (operation === "read") {
      await capturedQuotaError(createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, quotaSignal()));
    } else {
      await capturedQuotaError(createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()));
    }

    expect(fixture.logs.some(({ code }) => code === "CREDENTIAL_REFRESH_FAILED")).toBe(true);
    expect(JSON.stringify(fixture.logs)).not.toContain(derivedSecret);
  },
);

test.each(["read", "reset"] as const)(
  "a successful credential refresh during quota %s preserves an existing diagnostic and skips callbacks",
  async (operation) => {
    const token = `${operation}-refreshed-secret`;
    const fixture = createQuotaFixture(
      operation === "read"
        ? {
            read: async (context) => {
              await successfulRefresh(context, token);
              return { items: [] };
            },
          }
        : {
            read: async () => availableQuotaSnapshot,
            reset: async (context) => successfulRefresh(context, token),
          },
    );
    fixture.repository.writeDiagnostic(
      PROVIDER_ID,
      diagnostics("CREDENTIAL_REFRESH_FAILED", { providerId: PROVIDER_ID, retryable: false }),
    );
    const before = fixture.repository.readDiagnostics(PROVIDER_ID);

    if (operation === "read") {
      await createOAuthQuotaReader(fixture.dependencies).read(PROVIDER_ID, quotaSignal());
    } else {
      await createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal());
    }

    expect(fixture.repository.readDiagnostics(PROVIDER_ID)).toEqual(before);
    expect(fixture.repository.readAccount(PROVIDER_ID)).toMatchObject({
      credential: { token },
      label: `label-${token}`,
      expiresAt: 42,
    });
    expect(fixture.changed()).toBe(0);
  },
);
