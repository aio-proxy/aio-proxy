import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { MuseCodeHttpError, museControlFetch, museControlHeaders, museControlReadText } from './http';

export const MUSE_KEY_URL = 'https://api.meta.ai/muse-code/key';
export const MUSE_KEY_TIMEOUT_MS = 20_000;

export type MuseCodeKeyResponse = {
  readonly api_key?: string;
  readonly user_email?: string;
  readonly user_id?: string;
  readonly is_subs_active?: boolean;
  readonly subs_tier_id?: string;
  readonly subs_tier_name?: string;
  readonly require_payment?: boolean;
  readonly require_payment_action_url?: string;
  readonly action_url?: string | null;
  readonly subs_usage?: {
    readonly window?: MuseCodeUsageWindow | null;
    readonly weekly?: MuseCodeUsageWindow | null;
  } | null;
};

export type MuseCodeUsageWindow = {
  readonly used_percent?: number;
  readonly resets_at?: string | number;
  readonly window_duration_mins?: number;
};

export async function requestMuseCodeKey(
  accessToken: string,
  options: { readonly fetch?: RuntimeFetch; readonly signal?: AbortSignal; readonly onboard?: boolean },
): Promise<MuseCodeKeyResponse> {
  const timeout = AbortSignal.timeout(MUSE_KEY_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const response = await museControlFetch(options.fetch ?? globalThis.fetch, MUSE_KEY_URL, {
    method: 'POST',
    headers: museControlHeaders({
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(options.onboard === true ? { onboard: true } : {}),
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    throw new MuseCodeHttpError(
      'Muse Code key exchange failed',
      [408, 429].includes(response.status) || response.status >= 500,
      response.status,
    );
  }
  const text = await museControlReadText(response, signal);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Muse Code key exchange returned invalid JSON');
  }
  if (!isPlainObject(payload)) throw new Error('Muse Code key exchange returned invalid JSON');
  return payload as MuseCodeKeyResponse;
}

export function paymentActionUrl(payload: MuseCodeKeyResponse): string | undefined {
  const action = payload.action_url?.trim() || payload.require_payment_action_url?.trim();
  return action === '' ? undefined : action;
}
