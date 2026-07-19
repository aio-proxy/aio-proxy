import type { AuthorizationPort, ModelCatalog, OAuthAdapter } from "@aio-proxy/plugin-sdk";

import { zod } from "@aio-proxy/plugin-sdk";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiagnosticFactory, PluginLogSink } from "../diagnostic";

import {
  ABSENT_PROVIDER_DIGEST,
  AccountCleanupPendingError,
  deleteOAuthAccount,
  LOGIN_TIMEOUT_MS,
  type LoginOAuthAccountOptions,
  loginOAuthAccount,
  OAuthLoginResultValidationError,
  ORPHAN_ACCOUNT_GRACE_MS,
  PENDING_OPERATION_TTL_MS,
  ProviderAccountAlreadyExistsError,
  ProviderAccountChangedError,
  ProviderFingerprintMismatchError,
  RECOVERY_DRAIN_RETRY_MS,
  recoverPendingAccountOperations,
} from ".";
import { type OpenDbHandle, openDb } from "../../db";
import { AtomicConfigCommitUncertainError, AtomicConfigFile, digestProviderEntry } from "../config-file";
import { createPluginRegistryHost, type PluginRegistry } from "../registry";
import { createPluginRepository, type PluginRepository } from "../repository/index";

const roots: string[] = [];
const handles: OpenDbHandle[] = [];

const emptyCatalog = (): ModelCatalog => ({
  language: [],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  summary: code,
  retryable: options.retryable,
  occurredAt: "2026-07-15T00:00:00.000Z",
  ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
});

function fixture(initial: Record<string, unknown> = { plugins: [], providers: {} }) {
  const root = mkdtempSync(join(tmpdir(), "aio-proxy-account-login-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(path, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  const handle = openDb({ home: root });
  handles.push(handle);
  return {
    root,
    path,
    config: new AtomicConfigFile(path),
    repository: createPluginRepository(handle.sqlite),
    sqlite: handle.sqlite,
  };
}

function refreshCredential(state: ReturnType<typeof fixture>, expectedRevision: number, credential: unknown) {
  const owner = crypto.randomUUID();
  const now = Date.now();
  if (!state.repository.tryAcquireRefreshLease("person", owner, now, now + 60_000)) {
    throw new Error("lease unavailable");
  }
  try {
    return state.repository.compareAndSwapCredential("person", expectedRevision, owner, credential);
  } finally {
    state.repository.releaseRefreshLease("person", owner);
  }
}

type AdapterControls = {
  login?: OAuthAdapter<Record<string, unknown>, { token: string; refresh?: string }>["login"];
  discover?: OAuthAdapter<Record<string, unknown>, { token: string; refresh?: string }>["catalog"]["discover"];
  initialFallback?: OAuthAdapter<
    Record<string, unknown>,
    { token: string; refresh?: string }
  >["catalog"]["initialFallback"];
  defaultAliases?: OAuthAdapter<
    Record<string, unknown>,
    { token: string; refresh?: string }
  >["catalog"]["defaultAliases"];
  credentialSchema?: OAuthAdapter<Record<string, unknown>, { token: string; refresh?: string }>["credentials"];
  accountSchema?: OAuthAdapter<Record<string, unknown>, unknown>["account"]["options"]["schema"];
};

type LoginOverrides = Partial<Omit<LoginOAuthAccountOptions, "capability">> & {
  readonly capability?: LoginOAuthAccountOptions["capability"] | undefined;
};

function registry(controls: AdapterControls = {}): PluginRegistry {
  const host = createPluginRegistryHost();
  const staging = host.stage("@example/oauth");
  staging.api.oauth.register({
    id: "default",
    label: "Example OAuth",
    account: {
      options: {
        schema: controls.accountSchema ?? zod.object({ tenant: zod.string(), secret: zod.string() }),
        form: [
          { type: "text", key: "tenant", label: "Tenant" },
          { type: "secret", key: "secret", label: "Secret" },
        ],
      },
    },
    credentials: controls.credentialSchema ?? zod.object({ token: zod.string(), refresh: zod.string().optional() }),
    login:
      controls.login ??
      (async () => ({ fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "new" } })),
    catalog: {
      policy: { kind: "static" },
      discover: controls.discover ?? (async () => emptyCatalog()),
      ...(controls.initialFallback === undefined ? {} : { initialFallback: controls.initialFallback }),
      ...(controls.defaultAliases === undefined ? {} : { defaultAliases: controls.defaultAliases }),
    },
    async createRuntime() {
      throw new Error("not used");
    },
  });
  staging.seal();
  staging.commit();
  return host.registry;
}

const authorization: AuthorizationPort = {
  async presentDeviceCode() {},
  async loopback() {
    return { code: "code", redirectUri: "http://127.0.0.1/callback" };
  },
};

function options(state: ReturnType<typeof fixture>, overrides: LoginOverrides = {}): LoginOAuthAccountOptions {
  const result: Omit<LoginOAuthAccountOptions, "capability"> & {
    capability?: LoginOAuthAccountOptions["capability"] | undefined;
  } = {
    capability: { plugin: "@example/oauth", capability: "default" },
    registry: registry(),
    repository: state.repository,
    config: state.config,
    renderAccountOptions: async () => ({ publicValues: { tenant: "work" }, secrets: { secret: "hidden" } }),
    createAuthorization: () => authorization,
    diagnostics,
    logger: () => {},
    ...overrides,
  };
  if (Object.hasOwn(overrides, "capability") && overrides.capability === undefined) delete result.capability;
  return result as LoginOAuthAccountOptions;
}

async function createAccount(state: ReturnType<typeof fixture>, overrides: LoginOverrides = {}) {
  return loginOAuthAccount(options(state, overrides));
}

function configOf(state: ReturnType<typeof fixture>): Record<string, unknown> {
  return JSON.parse(readFileSync(state.path, "utf8")) as Record<string, unknown>;
}

function accountOf(state: ReturnType<typeof fixture>, providerId: string) {
  const account = state.repository.readAccount(providerId);
  if (account === null) throw new Error(`Missing test account: ${providerId}`);
  return account;
}

export type { LoginOAuthAccountOptions, OAuthAdapter, PluginLogSink, PluginRepository };
export {
  ABSENT_PROVIDER_DIGEST,
  AccountCleanupPendingError,
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  accountOf,
  authorization,
  configOf,
  createAccount,
  deleteOAuthAccount,
  diagnostics,
  digestProviderEntry,
  emptyCatalog,
  expect,
  fixture,
  LOGIN_TIMEOUT_MS,
  loginOAuthAccount,
  OAuthLoginResultValidationError,
  ORPHAN_ACCOUNT_GRACE_MS,
  options,
  PENDING_OPERATION_TTL_MS,
  ProviderAccountAlreadyExistsError,
  ProviderAccountChangedError,
  ProviderFingerprintMismatchError,
  RECOVERY_DRAIN_RETRY_MS,
  recoverPendingAccountOperations,
  refreshCredential,
  registry,
  test,
  zod,
};
