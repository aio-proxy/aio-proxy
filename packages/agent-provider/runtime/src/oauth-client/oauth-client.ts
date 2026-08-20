import {
  AGENT_CLIENT_ID,
  AgentDeviceCodeResponseSchema,
  AgentOAuthErrorSchema,
  AgentTokenResponseSchema,
  type AgentDeviceCodeResponse,
  type AgentManagedMarker,
  type AgentOAuthError,
  type AgentTokenResponse,
} from '@aio-proxy/types';

export type AgentRuntimeRequestOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentOAuthError['error'] | 'network' | 'invalid_response',
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

async function postForm(
  endpoint: string,
  path: string,
  body: Readonly<Record<string, string>>,
  options: AgentRuntimeRequestOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(new URL(path, endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    if (options.signal?.aborted === true) throw options.signal.reason;
    throw new AgentRuntimeError('network');
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AgentRuntimeError('invalid_response');
  }
  if (!response.ok) {
    const error = AgentOAuthErrorSchema.safeParse(payload);
    if (!error.success) throw new AgentRuntimeError('invalid_response');
    throw new AgentRuntimeError(error.data.error);
  }
  return payload;
}

export async function requestDeviceAuthorization(
  marker: AgentManagedMarker,
  options: AgentRuntimeRequestOptions = {},
): Promise<AgentDeviceCodeResponse> {
  const body = await postForm(
    marker.endpoint,
    '/oauth/device/code',
    {
      client_id: AGENT_CLIENT_ID[marker.agent],
      agent: marker.agent,
      installation_id: marker.installationId,
      adapter_version: marker.adapterVersion,
    },
    options,
  );
  const parsed = AgentDeviceCodeResponseSchema.safeParse(body);
  if (!parsed.success) throw new AgentRuntimeError('invalid_response');
  validateDeviceAuthorizationUrls(marker, parsed.data);
  return parsed.data;
}

async function requestToken(
  marker: AgentManagedMarker,
  body: Readonly<Record<string, string>>,
  options: AgentRuntimeRequestOptions,
): Promise<AgentTokenResponse> {
  const payload = await postForm(marker.endpoint, '/oauth/token', body, options);
  const parsed = AgentTokenResponseSchema.safeParse(payload);
  if (!parsed.success) throw new AgentRuntimeError('invalid_response');
  return parsed.data;
}

export async function pollDeviceAuthorization(
  marker: AgentManagedMarker,
  device: AgentDeviceCodeResponse,
  options: AgentRuntimeRequestOptions = {},
): Promise<AgentTokenResponse> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + device.expires_in * 1_000;
  let intervalSeconds: number = device.interval;
  const form = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: AGENT_CLIENT_ID[marker.agent],
    device_code: device.device_code,
  } as const;
  while (now() < deadline) {
    throwIfAborted(options.signal);
    await sleep(intervalSeconds * 1_000);
    throwIfAborted(options.signal);
    if (now() >= deadline) break;
    try {
      return await requestToken(marker, form, options);
    } catch (error) {
      if (!(error instanceof AgentRuntimeError)) throw error;
      if (error.code !== 'authorization_pending' && error.code !== 'slow_down') throw error;
      if (error.code === 'slow_down') intervalSeconds += 5;
    }
  }
  throw new AgentRuntimeError('expired_token');
}

export function refreshAgentCredential(
  marker: AgentManagedMarker,
  refreshToken: string,
  options: AgentRuntimeRequestOptions = {},
): Promise<AgentTokenResponse> {
  return requestToken(
    marker,
    {
      grant_type: 'refresh_token',
      client_id: AGENT_CLIENT_ID[marker.agent],
      refresh_token: refreshToken,
    },
    options,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

function validateDeviceAuthorizationUrls(marker: AgentManagedMarker, device: AgentDeviceCodeResponse): void {
  const expected = new URL('/dashboard/agents/authorize', marker.endpoint);
  const base = new URL(device.verification_uri);
  const complete = new URL(device.verification_uri_complete);
  const fragment = new URLSearchParams(complete.hash.slice(1));
  const completeCode = fragment.get('code');
  const valid =
    base.origin === expected.origin &&
    base.pathname === expected.pathname &&
    base.username === '' &&
    base.password === '' &&
    base.search === '' &&
    base.hash === '' &&
    complete.origin === expected.origin &&
    complete.pathname === expected.pathname &&
    complete.username === '' &&
    complete.password === '' &&
    complete.search === '' &&
    completeCode === device.user_code &&
    [...fragment.keys()].length === 1;
  if (!valid) throw new AgentRuntimeError('invalid_response');
}
