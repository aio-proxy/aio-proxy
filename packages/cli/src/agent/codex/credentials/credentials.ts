import { parseRuntimeConfig } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';

import type { CredentialDeps, KeyChoice, KeySnapshot, ResolvedCredential } from '../contracts';

type CredentialStatus = 'ok' | 'offline' | 'unauthorized' | 'invalid_response';

export type CredentialErrorCode =
  | 'CREDENTIAL_CONFIG_INVALID'
  | 'CREDENTIAL_INVALID_RESPONSE'
  | 'CREDENTIAL_NO_SELECTION'
  | 'CREDENTIAL_SELECTION_STALE'
  | 'CREDENTIAL_UNAUTHORIZED';

export class CredentialError extends Error {
  override readonly name = 'CredentialError';

  constructor(readonly code: CredentialErrorCode) {
    super(code);
  }
}

type AuthoredKey = Readonly<Record<string, unknown>> & { readonly key: string; readonly label?: string };
type RuntimeKey = { readonly key: string; readonly label?: string };
type CredentialState = {
  readonly authoredKeys: readonly AuthoredKey[];
  readonly runtimeKeys: readonly RuntimeKey[];
  readonly revision: string;
};

const asCredentialError = (code: CredentialErrorCode): CredentialError => new CredentialError(code);

export async function probeProxyApiKey(input: {
  readonly endpoint: string;
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}): Promise<CredentialStatus> {
  try {
    const response = await (input.fetch ?? fetch)(`${input.endpoint.replace(/\/+$/u, '')}/v1/models`, {
      headers: { authorization: `Bearer ${input.token}` },
      signal: input.signal ?? AbortSignal.timeout(3_000),
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    if (!response.ok) return response.status >= 500 ? 'offline' : 'invalid_response';
    const body: unknown = await response.json().catch(() => undefined);
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? 'ok' : 'invalid_response';
  } catch {
    return 'offline';
  }
}

function authoredKeys(raw: Record<string, unknown>): readonly AuthoredKey[] {
  const server = raw['server'];
  if (server === undefined) return [];
  if (!isPlainObject(server)) throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
  const values = server['apiKeys'];
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
  return values.map((value) => {
    if (!isPlainObject(value) || typeof value['key'] !== 'string' || value['key'].length === 0)
      throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
    const label = value['label'];
    if (label !== undefined && (typeof label !== 'string' || label.length === 0))
      throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
    return value as AuthoredKey;
  });
}

const revisionOf = (authored: readonly AuthoredKey[], runtime: readonly RuntimeKey[]): string =>
  JSON.stringify({ authored, runtime });

const choiceId = (revision: string, index: number, key: AuthoredKey): string =>
  Bun.hash(`${revision}:${index}:${JSON.stringify(key)}`).toString(16);

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
    return { authoredKeys: authored, runtimeKeys, revision: revisionOf(authored, runtimeKeys) };
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw asCredentialError('CREDENTIAL_CONFIG_INVALID');
  }
}

function requireCurrentSelection(initial: CredentialState, current: CredentialState): void {
  if (initial.revision !== current.revision) throw asCredentialError('CREDENTIAL_SELECTION_STALE');
}

const credentialForStatus = async (
  deps: CredentialDeps,
  token: string,
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
    kind: 'existing',
    ...(label === undefined ? {} : { label }),
    verified: status === 'ok',
  };
};

export async function inspectProxyKeys(deps: CredentialDeps): Promise<KeySnapshot> {
  const initial = await readState(deps);
  if (initial.runtimeKeys.length === 0) {
    return {
      choices: [],
      resolve: async (selection) => {
        if (selection.kind !== 'none') throw asCredentialError('CREDENTIAL_NO_SELECTION');
        const current = await readState(deps);
        requireCurrentSelection(initial, current);
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
    resolve: async (selection) => {
      if (selection.kind !== 'existing') throw asCredentialError('CREDENTIAL_NO_SELECTION');
      const current = await readState(deps);
      requireCurrentSelection(initial, current);
      const index = choices.findIndex((choice) => choice.id === selection.id);
      if (index < 0) throw asCredentialError('CREDENTIAL_SELECTION_STALE');
      const authored = current.authoredKeys[index];
      const runtime = current.runtimeKeys[index];
      if (
        authored === undefined ||
        runtime === undefined ||
        choiceId(current.revision, index, authored) !== selection.id
      )
        throw asCredentialError('CREDENTIAL_SELECTION_STALE');
      return credentialForStatus(deps, runtime.key, runtime.label);
    },
  };
}
