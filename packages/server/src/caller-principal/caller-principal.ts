import { createHmac, randomBytes } from 'node:crypto';

import type { Context } from 'hono';

/** `/v1/*` authentication proves a caller may use the proxy, not that it owns a
 *  given realtime call. Ownership needs a stable identity captured at create time,
 *  because `stripCallerCredentials` deletes the credential before the route runs. */
export type CallerPrincipal = {
  readonly kind: 'agent' | 'key' | 'anonymous';
  readonly id?: string;
};

export type CallerPrincipalEnv = { Variables: { callerPrincipal?: CallerPrincipal } };

/** With no configured keys the proxy has no notion of distinct callers, so every
 *  caller is this one principal and ownership checks pass. Rejecting the single
 *  legitimate client would be worse than not distinguishing callers. */
export const ANONYMOUS_CALLER: CallerPrincipal = Object.freeze({ kind: 'anonymous' });

/** `AgentAccessGrant.tokenHash` rotates on every refresh and would 403 the same
 *  client mid-call; `installationId` is the stable identity. */
export function agentCallerPrincipal(installationId: string): CallerPrincipal {
  return { kind: 'agent', id: installationId };
}

// A bare digest of a configured key is an offline verifier for it, and
// `StaticApiKeySchema` only requires one character, so `key: "1234"` would be trivially
// reversed wherever the principal is carried. Keying with a per-process secret makes the
// id opaque, as `dashboard-routes/settings`'s `apiKeysRevision` does for the same reason.
// The secret must not be regenerated per call — a caller's create and attach requests have
// to derive the same id — but it need not outlive the process: principals live only in the
// in-memory realtime call store, whose records die with it.
const callerKeyingMaterial = randomBytes(32);

/** Identifies the presented credential rather than a person: the id derives from the
 *  configured entry that matched, so a caller that creates a realtime call under one
 *  configured key and attaches under another is a different principal and is refused.
 *  Both requests of a session must present the same configured key. */
export function staticKeyCallerPrincipal(key: string): CallerPrincipal {
  return { kind: 'key', id: `sha256:${createHmac('sha256', callerKeyingMaterial).update(key).digest('hex')}` };
}

export function callerPrincipal(context: Context<CallerPrincipalEnv>): CallerPrincipal {
  return context.get('callerPrincipal') ?? ANONYMOUS_CALLER;
}
