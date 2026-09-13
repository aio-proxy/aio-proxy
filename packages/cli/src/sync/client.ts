import { readFile } from 'node:fs/promises';

import { canonicalizeLoopbackHost } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import {
  SyncApplyInputSchema,
  SyncHistoryItemSchema,
  SyncPreviewInputSchema,
  SyncPreviewSchema,
  SyncStatusSchema,
  type SyncApplyInput,
  type SyncHistoryItem,
  type SyncPreview,
  type SyncPreviewInput,
  type SyncStatus,
} from '@aio-proxy/types';
import { input, password } from '@inquirer/prompts';
import { z } from 'zod';

import { connectHost } from '../agent/control-plane/control-plane';
import { controlBaseUrl, resolveControlAddress } from '../control-plane';
import { openBrowser } from '../open-browser';
import { createCliAuthorizationPort, createDefaultCliAuthorizationCopy } from '../plugin-commands/authorization';
import { startDetachSession, type SyncAuthorizationPort } from './detach-session';
import { SyncCliError } from './errors';

export interface SyncCliDeps {
  endpoint(): Promise<string>;
  authenticate(): Promise<string | undefined>;
  request(path: string, init: RequestInit): Promise<Response>;
  write(value: string): void;
  authorization?: SyncAuthorizationPort;
  readManualCallbackUrl?(authorizationUrl: string, signal: AbortSignal): Promise<string>;
}

export { SyncCliError };
export type { SyncAuthorizationPort };

type SyncClient = {
  readonly status: () => Promise<SyncStatus>;
  readonly preview: (input: SyncPreviewInput) => Promise<SyncPreview>;
  readonly apply: (input: SyncApplyInput) => Promise<SyncStatus>;
  readonly range: (providerId: string) => Promise<SyncStatus>;
  readonly history: (objectId: string) => Promise<readonly SyncHistoryItem[]>;
  readonly detach: (providerId: string, loginSessionId: string) => Promise<SyncStatus>;
  readonly cancelDetach: (providerId: string) => Promise<SyncStatus>;
  readonly retry: () => Promise<SyncStatus>;
  readonly disconnect: () => Promise<SyncStatus>;
  readonly startDetachSession: (providerId: string) => Promise<string>;
};

/** Mutations can outlive the read timeout: CloudKit artifact setup and reconciliation are minutes, not seconds. */
const MUTATION_TIMEOUT_MS = 10 * 60_000;

const mutation = (init: RequestInit): RequestInit => ({ ...init, signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS) });

const errorCode = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = Reflect.get(body, 'error');
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
};

function mapError(code: string | undefined, status: number, url: string): SyncCliError {
  if (status === 401 || code === 'authentication_required')
    return new SyncCliError('authentication_required', m['cli.sync.authentication_required']());
  if (status === 403) return new SyncCliError('access_denied', m['cli.sync.access_denied']());
  if (code === 'dashboard_unavailable')
    return new SyncCliError('service-not-running', m['cli.sync.service_not_running']({ url }), true);
  switch (code) {
    case 'preview-stale':
      return new SyncCliError('preview-stale', m['cli.sync.preview_stale']());
    case 'not-connected':
      return new SyncCliError('not-connected', m['cli.sync.not_connected']());
    case 'backend-unavailable':
      return new SyncCliError('backend-unavailable', m['cli.sync.backend_unavailable']());
    case 'dependency-in-use':
      return new SyncCliError('dependency-in-use', m['cli.sync.dependency_in_use']());
    case 'detach-required':
      return new SyncCliError('detach-required', m['cli.sync.detach_required']());
    case 'operation-pending':
      return new SyncCliError('operation-pending', m['cli.sync.operation_pending']());
    case 'upgrade-required':
      return new SyncCliError('upgrade-required', m['cli.sync.upgrade_required']());
    case 'invalid-request':
      return new SyncCliError('invalid-request', m['cli.sync.invalid_request']());
    default:
      return new SyncCliError('request-failed', m['cli.sync.request_failed']({ status: String(status) }));
  }
}

const parseResponse = async (response: Response): Promise<unknown> => response.json().catch(() => undefined);

const stripFinalLineEnding = (value: string): string => value.replace(/\r?\n$/u, '');

export function createSyncClient(deps: SyncCliDeps): SyncClient {
  const requestJson = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    let response: Response;
    let url: string;
    try {
      await deps.authenticate();
      response = await deps.request(path, init);
      url = `${await deps.endpoint()}${path}`;
    } catch (error) {
      if (error instanceof SyncCliError) throw error;
      url = await deps.endpoint().catch(() => path);
      throw new SyncCliError('service-not-running', m['cli.sync.service_not_running']({ url }), true);
    }
    const body = await parseResponse(response);
    if (!response.ok) throw mapError(errorCode(body), response.status, url);
    return body;
  };

  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new SyncCliError('invalid-response', m['cli.sync.invalid_response']());
    return result.data;
  };

  const send = (path: string, body: unknown, method = 'POST'): Promise<unknown> =>
    requestJson(
      path,
      mutation({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    );

  return {
    async status() {
      return parse(SyncStatusSchema, await requestJson('/dashboard/api/sync'));
    },
    async preview(input) {
      return parse(SyncPreviewSchema, await send('/dashboard/api/sync/preview', parse(SyncPreviewInputSchema, input)));
    },
    async apply(input) {
      return parse(SyncStatusSchema, await send('/dashboard/api/sync/apply', parse(SyncApplyInputSchema, input)));
    },
    async range(providerId) {
      return parse(SyncStatusSchema, await send('/dashboard/api/sync/range', { providerId, included: false }, 'PUT'));
    },
    async history(objectId) {
      const path = `/dashboard/api/sync/history/${encodeURIComponent(objectId)}`;
      return parse(z.object({ items: z.array(SyncHistoryItemSchema) }), await requestJson(path)).items;
    },
    async detach(providerId, loginSessionId) {
      return parse(SyncStatusSchema, await send('/dashboard/api/sync/detach', { providerId, loginSessionId }));
    },
    async cancelDetach(providerId) {
      return parse(SyncStatusSchema, await send('/dashboard/api/sync/detach/cancel', { providerId }));
    },
    async retry() {
      return parse(SyncStatusSchema, await requestJson('/dashboard/api/sync/retry', mutation({ method: 'POST' })));
    },
    async disconnect() {
      return parse(SyncStatusSchema, await requestJson('/dashboard/api/sync/disconnect', mutation({ method: 'POST' })));
    },
    startDetachSession(providerId) {
      return startDetachSession(providerId, { ...deps, requestJson, write: (value) => deps.write(value) });
    },
  };
}

export type DefaultSyncCliDepsOptions = {
  readonly passwordStdin?: boolean;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly readPassword?: () => Promise<string>;
  readonly readPasswordStdin?: () => Promise<string>;
  readonly write?: (value: string) => void;
};

export function createDefaultSyncCliDeps(options: DefaultSyncCliDepsOptions = {}): SyncCliDeps {
  let endpoint: string | undefined;
  let token: string | undefined;
  let authenticated = false;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const resolveEndpoint = async (): Promise<string> => {
    if (endpoint !== undefined) return endpoint;
    const address = await resolveControlAddress({});
    const base = controlBaseUrl(connectHost(address.host, { allowRemote: true }), address.port);
    // controlBaseUrl only ever speaks http, so a non-loopback endpoint would put the Dashboard
    // password and any secret backend options on the wire in cleartext. Refuse before the first
    // request rather than after sending one: an impostor peer that answers /auth/session with
    // "disabled" would otherwise skip a check placed on the password path alone.
    if (canonicalizeLoopbackHost(new URL(base).hostname) === undefined)
      throw new SyncCliError('insecure-endpoint', m['cli.sync.insecure_endpoint']({ url: base }));
    endpoint = base;
    return endpoint;
  };
  const readStdin = async () => stripFinalLineEnding(await (options.readPasswordStdin?.() ?? Bun.stdin.text()));
  const readPassword =
    options.readPassword ?? (async () => password({ message: m['cli.sync.password_prompt'](), mask: '*' }));
  const write = options.write ?? console.log;
  const interactive = process.stdin.isTTY === true;
  const readManualCallbackUrl = (authorizationUrl: string, signal: AbortSignal): Promise<string> =>
    input({ message: authorizationUrl }, { signal });

  return {
    endpoint: resolveEndpoint,
    authorization: createCliAuthorizationPort({
      copy: createDefaultCliAuthorizationCopy(),
      openBrowser,
      copyToClipboard: () => false,
      print: write,
      readManualCallbackUrl,
      confirmManualOnly: async () => false,
      signal: new AbortController().signal,
    }),
    ...(interactive ? { readManualCallbackUrl } : {}),
    async authenticate() {
      if (authenticated) return token;
      authenticated = true;
      const base = await resolveEndpoint();
      let session: Response;
      try {
        session = await fetchImpl(`${base}/dashboard/api/auth/session`, {
          headers: { Origin: base },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new SyncCliError('service-not-running', m['cli.sync.service_not_running']({ url: base }), true);
      }
      const sessionBody = (await parseResponse(session)) as { readonly status?: unknown } | undefined;
      if (sessionBody?.status === 'disabled') return undefined;
      if (sessionBody?.status === 'unavailable')
        throw new SyncCliError('service-not-running', m['cli.sync.service_not_running']({ url: base }), true);
      const secret = options.passwordStdin === true ? await readStdin() : await readPassword();
      if (secret.length === 0) throw new SyncCliError('authentication-required', m['cli.sync.password_required']());
      let login: Response;
      try {
        login = await fetchImpl(`${base}/dashboard/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: base },
          body: JSON.stringify({ password: secret }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new SyncCliError('service-not-running', m['cli.sync.service_not_running']({ url: base }), true);
      }
      const body = (await parseResponse(login)) as { readonly token?: unknown; readonly error?: unknown } | undefined;
      if (!login.ok) {
        const code = typeof body?.error === 'string' ? body.error : undefined;
        if (code === 'invalid_password') throw new SyncCliError('invalid-password', m['cli.sync.invalid_password']());
        if (code === 'rate_limited') throw new SyncCliError('rate-limited', m['cli.sync.rate_limited']());
        throw new SyncCliError('authentication-failed', m['cli.sync.authentication_failed']());
      }
      if (typeof body?.token !== 'string' || body.token.length === 0)
        throw new SyncCliError('authentication-failed', m['cli.sync.authentication_failed']());
      token = body.token;
      return token;
    },
    async request(path, init) {
      const base = await resolveEndpoint();
      const headers = new Headers(init.headers);
      headers.set('Origin', base);
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
      return fetchImpl(`${base}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000) });
    },
    write: write,
  };
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new SyncCliError('invalid-file', m['cli.sync.invalid_file']({ path }));
  }
}
