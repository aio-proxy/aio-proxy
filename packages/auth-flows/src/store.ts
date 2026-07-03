import { openDb } from "@aio-proxy/core/db";
import { auth } from "@aio-proxy/core/db/schema/auth";
import { and, eq } from "drizzle-orm";
import { AuthCasBusyError, StaleProviderGenerationError } from "./errors";
import {
  hasToken,
  parsePayload,
  readAccountLabel,
  readExpiresAt,
  serializePayload,
} from "./payload";
import type {
  AuthCasCurrent,
  AuthCasNext,
  AuthRecord,
  AuthSummary,
} from "./store-types";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const CAS_BUSY_TIMEOUT_MS = 350;

type StoredCasRow = {
  readonly accountFingerprint: string | null;
  readonly payload: string;
};

export const Auth = { get, set, list, del, cas } as const;

function get(vendor: string, providerId: string): AuthRecord | null {
  const handle = openDb();
  try {
    const row = handle.db
      .select({
        vendor: auth.vendor,
        providerId: auth.providerId,
        accountFingerprint: auth.accountFingerprint,
        payload: auth.payload,
      })
      .from(auth)
      .where(and(eq(auth.vendor, vendor), eq(auth.providerId, providerId)))
      .get();

    if (row === undefined) {
      return null;
    }

    return { ...row, payload: parsePayload(row.payload) };
  } finally {
    handle.close();
  }
}

function set(
  vendor: string,
  providerId: string,
  payload: unknown,
  accountFingerprint: string | null = null,
): void {
  const handle = openDb();
  const payloadJson = serializePayload(payload);
  const updatedAt = new Date();
  try {
    handle.db
      .insert(auth)
      .values({
        vendor,
        providerId,
        accountFingerprint,
        payload: payloadJson,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [auth.vendor, auth.providerId],
        set: {
          accountFingerprint,
          payload: payloadJson,
          updatedAt,
        },
      })
      .run();
  } finally {
    handle.close();
  }
}

function list(): AuthSummary[] {
  const handle = openDb();
  try {
    const rows = handle.db
      .select({
        vendor: auth.vendor,
        providerId: auth.providerId,
        payload: auth.payload,
      })
      .from(auth)
      .all();

    return rows.map((row) => {
      const payload = parsePayload(row.payload);
      return {
        vendor: row.vendor,
        providerId: row.providerId,
        hasToken: hasToken(payload),
        expiresAt: readExpiresAt(payload),
        accountLabel: readAccountLabel(payload),
      };
    });
  } finally {
    handle.close();
  }
}

function del(vendor: string, providerId: string): void {
  const handle = openDb();
  try {
    handle.db
      .delete(auth)
      .where(and(eq(auth.vendor, vendor), eq(auth.providerId, providerId)))
      .run();
  } finally {
    handle.close();
  }
}

function cas(
  vendor: string,
  providerId: string,
  expectedFingerprint: string | null,
  mutator: (current: AuthCasCurrent | null) => AuthCasNext,
): void {
  const handle = openDb();
  const { sqlite } = handle;

  try {
    const casTx = sqlite.transaction(() => {
      const existing = readCasRow(vendor, providerId, sqlite);
      assertExpectedFingerprint(
        vendor,
        providerId,
        expectedFingerprint,
        existing,
      );
      const next = mutator(
        existing === null
          ? null
          : {
              payload: parsePayload(existing.payload),
              accountFingerprint: existing.accountFingerprint,
            },
      );

      const result = sqlite
        .prepare(
          `INSERT INTO auth (vendor, provider_id, account_fingerprint, payload, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(vendor, provider_id) DO UPDATE SET
             account_fingerprint = excluded.account_fingerprint,
             payload = excluded.payload,
             updated_at = excluded.updated_at
           WHERE (?6 IS NULL AND auth.account_fingerprint IS NULL)
              OR (?6 IS NOT NULL AND auth.account_fingerprint = ?6)`,
        )
        .run(
          vendor,
          providerId,
          next.accountFingerprint,
          serializePayload(next.payload),
          Date.now(),
          expectedFingerprint,
        );

      if (result.changes === 0) {
        throw new StaleProviderGenerationError(
          vendor,
          providerId,
          expectedFingerprint,
          "<concurrent>",
        );
      }
    });

    sqlite.exec(`PRAGMA busy_timeout = ${CAS_BUSY_TIMEOUT_MS}`);
    try {
      casTx.immediate();
    } catch (error) {
      if (isSqliteBusy(error)) {
        throw new AuthCasBusyError(vendor, providerId, error);
      }
      throw error;
    } finally {
      sqlite.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    }
  } finally {
    handle.close();
  }
}

function readCasRow(
  vendor: string,
  providerId: string,
  sqlite: ReturnType<typeof openDb>["sqlite"],
): StoredCasRow | null {
  const row = sqlite
    .prepare(
      "SELECT account_fingerprint, payload FROM auth WHERE vendor = ? AND provider_id = ?",
    )
    .get(vendor, providerId);

  if (row === null || row === undefined) {
    return null;
  }

  if (
    typeof row === "object" &&
    "account_fingerprint" in row &&
    "payload" in row &&
    (typeof row.account_fingerprint === "string" ||
      row.account_fingerprint === null) &&
    typeof row.payload === "string"
  ) {
    return {
      accountFingerprint: row.account_fingerprint,
      payload: row.payload,
    };
  }

  throw new TypeError("auth CAS query returned an unexpected row shape");
}

function assertExpectedFingerprint(
  vendor: string,
  providerId: string,
  expectedFingerprint: string | null,
  existing: StoredCasRow | null,
): void {
  if (expectedFingerprint === null) {
    if (existing !== null && existing.accountFingerprint !== null) {
      throw new StaleProviderGenerationError(
        vendor,
        providerId,
        null,
        existing.accountFingerprint,
      );
    }
    return;
  }

  if (
    existing === null ||
    existing.accountFingerprint !== expectedFingerprint
  ) {
    throw new StaleProviderGenerationError(
      vendor,
      providerId,
      expectedFingerprint,
      existing?.accountFingerprint ?? null,
    );
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if ("code" in error && typeof error.code === "string") {
    return error.code.startsWith("SQLITE_BUSY");
  }

  return error.message.includes("SQLITE_BUSY");
}
