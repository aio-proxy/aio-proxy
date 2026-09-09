import { createHash } from 'node:crypto';

import { AtomicConfigCommitUncertainError, type AtomicConfigFile, parseRuntimeConfig } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';

import type { CredentialDeps, KeyChoice, KeySnapshot, ResolvedCredential } from '../contracts';

type CredentialStatus = 'ok' | 'offline' | 'unauthorized' | 'invalid_response';

export type CredentialErrorCode =
  | 'CREDENTIAL_AUTH_DISABLED'
  | 'CREDENTIAL_COMMIT_UNCERTAIN'
  | 'CREDENTIAL_CONFIG_INVALID'
  | 'CREDENTIAL_GENERATION_FAILED'
  | 'CREDENTIAL_INVALID_RESPONSE'
  | 'CREDENTIAL_NO_SELECTION'
  | 'CREDENTIAL_OFFLINE'
  | 'CREDENTIAL_RELOAD_REJECTED'
  | 'CREDENTIAL_SELECTION_STALE'
  | 'CREDENTIAL_UNAUTHORIZED'
  | 'CREDENTIAL_WRITE_FAILED';

export class CredentialError extends Error {
  override readonly name = 'CredentialError';

  constructor(readonly code: CredentialErrorCode) {
    super(code);
  }
}

type AuthoredKey = Readonly<Record<string, unknown>> & { readonly key: string; readonly label?: string };
type CredentialState = {
  readonly raw: Record<string, unknown>;
  readonly authoredKeys: readonly AuthoredKey[];
  readonly runtimeKeys: readonly { readonly key: string; readonly label?: string }[];
  readonly revision: string;
};

const asCredentialError = (code: CredentialErrorCode): CredentialError => new CredentialError(code);

function authoredKeys(raw: Record<string, unknown>): readonly AuthoredKey[] {
  const server = raw['server'];
  if (server === undefined) return [];
  if (!isPlainObject(server)) throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
  const values = server['apiKeys'];
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
  return values.map((value) => {
    if (!isPlainObject(value) || typeof value['key'] !== 'string' || value['key'].length === 0) {
      throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
    }
    const label = value['label'];
    if (label !== undefined && (typeof label !== 'string' || label.length === 0)) {
      throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
    }
    return value as AuthoredKey;
  });
}

const revisionOf = (
  authored: readonly AuthoredKey[],
  runtime: readonly { readonly key: string; readonly label?: string }[],
): string => createHash('sha256').update(JSON.stringify({ authored, runtime })).digest('hex');

const choiceId = (revision: string, index: number, key: AuthoredKey): string =>
  createHash('sha256')
    .update(`${revision}:${index}:${JSON.stringify(key)}`)
    .digest('hex');

const choiceLabel = (key: AuthoredKey, index: number): string => key.label ?? `API key ${index + 1}`;

async function readState(deps: CredentialDeps): Promise<CredentialState> {
  try {
    deps.loadEnvironment();
    const raw = await deps.file.read();
    const authored = authoredKeys(raw);
    const runtime = parseRuntimeConfig(raw, deps.readEnvironment());
    const runtimeKeys = runtime.server.apiKeys.map((entry) => ({
      key: entry.key,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    }));
    if (runtimeKeys.length !== authored.length) throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
    return { raw, authoredKeys: authored, runtimeKeys, revision: revisionOf(authored, runtimeKeys) };
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
  }
}

function requireCurrentSelection(initial: CredentialState, current: CredentialState): void {
  if (initial.revision !== current.revision || initial.authoredKeys.length !== current.authoredKeys.length) {
    throw asCredentialError('CREDENTIAL_SELECTION_STALE');
  }
}

const credentialForStatus = async (
  deps: CredentialDeps,
  token: string,
  kind: 'existing' | 'created',
  label: string | undefined,
): Promise<ResolvedCredential> => {
  let status: CredentialStatus;
  try {
    status = await deps.check(token);
  } catch {
    status = 'offline';
  }
  if (status === 'unauthorized') throw asCredentialError('CREDENTIAL_UNAUTHORIZED');
  if (status === 'invalid_response') throw asCredentialError('CREDENTIAL_INVALID_RESPONSE');
  return {
    token,
    kind,
    ...(label === undefined ? {} : { label }),
    verified: status === 'ok',
  };
};

async function proxyIsOnline(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/u, '')}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

const hasTransientFlag = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { readonly transient?: unknown }).transient === true;

async function authoredContains(file: AtomicConfigFile, token: string): Promise<boolean> {
  try {
    const raw = await file.read();
    return authoredKeys(raw).some((entry) => entry.key === token);
  } catch {
    return false;
  }
}

async function recoverRuntime(deps: CredentialDeps): Promise<void> {
  try {
    await deps.reload();
  } catch {
    throw asCredentialError('CREDENTIAL_COMMIT_UNCERTAIN');
  }
}

async function createCredential(
  deps: CredentialDeps,
  initial: CredentialState,
  providerId: string,
): Promise<ResolvedCredential> {
  const online = await proxyIsOnline(deps.endpoint);
  let token: string;
  try {
    token = deps.randomKey();
  } catch {
    throw asCredentialError('CREDENTIAL_GENERATION_FAILED');
  }
  if (typeof token !== 'string' || token.length === 0) throw asCredentialError('CREDENTIAL_GENERATION_FAILED');
  const label = `Codex: ${providerId}`;
  let verified = false;
  let verificationUncertain = false;
  try {
    await deps.file.transaction(
      async (current) => {
        const currentState = await readState({ ...deps, file: deps.file });
        if (currentState.runtimeKeys.length === 0) throw asCredentialError('CREDENTIAL_AUTH_DISABLED');
        requireCurrentSelection(initial, currentState);
        const server = current['server'];
        if (!isPlainObject(server)) throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
        const next = {
          ...current,
          server: {
            ...server,
            apiKeys: [...currentState.authoredKeys, { key: token, label }],
          },
        };
        return { next, result: undefined };
      },
      {
        validateCandidate: (candidate) => {
          try {
            parseRuntimeConfig(candidate, deps.readEnvironment());
          } catch {
            throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
          }
        },
        verify: async () => {
          if (!online) return;
          try {
            await deps.reload();
          } catch (error) {
            // An online daemon that disappears after the candidate is written leaves the
            // commit state unknown. Returning lets AtomicConfigFile keep the key so a
            // possibly-used credential is never deleted by a blind rollback.
            if (error instanceof AtomicConfigCommitUncertainError || hasTransientFlag(error)) {
              verificationUncertain = true;
              return;
            }
            throw asCredentialError('CREDENTIAL_RELOAD_REJECTED');
          }
          let status: CredentialStatus;
          try {
            status = await deps.check(token);
          } catch {
            verificationUncertain = true;
            return;
          }
          if (status === 'offline') {
            verificationUncertain = true;
            return;
          }
          if (status === 'ok') {
            verified = true;
            return;
          }
          throw asCredentialError(
            status === 'unauthorized' ? 'CREDENTIAL_UNAUTHORIZED' : 'CREDENTIAL_INVALID_RESPONSE',
          );
        },
      },
    );
    if (verificationUncertain) {
      // The candidate was intentionally retained. Reconcile before reporting uncertainty;
      // only attempt the old-runtime reload if the candidate is already absent.
      if (!(await authoredContains(deps.file, token))) await recoverRuntime(deps);
      throw asCredentialError('CREDENTIAL_COMMIT_UNCERTAIN');
    }
  } catch (error) {
    if (error instanceof CredentialError && error.code === 'CREDENTIAL_AUTH_DISABLED') throw error;
    if (
      error instanceof CredentialError &&
      (error.code === 'CREDENTIAL_SELECTION_STALE' || error.code === 'CREDENTIAL_CONFIG_INVALID')
    ) {
      throw error;
    }
    if (
      error instanceof CredentialError &&
      (error.code === 'CREDENTIAL_UNAUTHORIZED' || error.code === 'CREDENTIAL_INVALID_RESPONSE')
    ) {
      if (await authoredContains(deps.file, token)) throw asCredentialError('CREDENTIAL_COMMIT_UNCERTAIN');
      await recoverRuntime(deps);
      throw error;
    }
    if (error instanceof CredentialError && error.code === 'CREDENTIAL_RELOAD_REJECTED') {
      if (await authoredContains(deps.file, token)) throw asCredentialError('CREDENTIAL_COMMIT_UNCERTAIN');
      await recoverRuntime(deps);
      throw error;
    }
    if (error instanceof AtomicConfigCommitUncertainError || error instanceof CredentialError) {
      if (await authoredContains(deps.file, token)) throw asCredentialError('CREDENTIAL_COMMIT_UNCERTAIN');
      await recoverRuntime(deps);
      throw asCredentialError('CREDENTIAL_COMMIT_UNCERTAIN');
    }
    if (await authoredContains(deps.file, token)) throw asCredentialError('CREDENTIAL_COMMIT_UNCERTAIN');
    await recoverRuntime(deps);
    throw asCredentialError('CREDENTIAL_WRITE_FAILED');
  }
  return { token, kind: 'created', label, verified };
}

export async function inspectProxyKeys(deps: CredentialDeps): Promise<KeySnapshot> {
  const initial = await readState(deps);
  if (initial.runtimeKeys.length === 0) {
    return {
      choices: [],
      resolve: async (selection) => {
        if (selection.kind !== 'none') throw asCredentialError('CREDENTIAL_AUTH_DISABLED');
        // The fixed placeholder only identifies an unauthenticated proxy. It must not
        // claim that the endpoint is reachable or that /v1/models was verified.
        return { token: 'aio-proxy-local', kind: 'placeholder', verified: false };
      },
    };
  }
  const choices: readonly KeyChoice[] = initial.authoredKeys.map((key, index) => ({
    id: choiceId(initial.revision, index, key),
    label: choiceLabel(key, index),
  }));
  return {
    choices,
    resolve: async (selection, providerId) => {
      if (selection.kind === 'none') throw asCredentialError('CREDENTIAL_NO_SELECTION');
      const current = await readState(deps);
      requireCurrentSelection(initial, current);
      if (selection.kind === 'existing') {
        const index = choices.findIndex((choice) => choice.id === selection.id);
        if (index < 0) throw asCredentialError('CREDENTIAL_SELECTION_STALE');
        const entry = current.runtimeKeys[index];
        if (entry === undefined || choiceId(current.revision, index, current.authoredKeys[index]!) !== selection.id) {
          throw asCredentialError('CREDENTIAL_SELECTION_STALE');
        }
        return credentialForStatus(deps, entry.key, 'existing', entry.label);
      }
      return createCredential(deps, initial, providerId);
    },
  };
}
