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

export function staticKeyCallerPrincipal(key: string): CallerPrincipal {
  return { kind: 'key', id: `sha256:${new Bun.CryptoHasher('sha256').update(key).digest('hex')}` };
}

export function callerPrincipal(context: Context<CallerPrincipalEnv>): CallerPrincipal {
  return context.get('callerPrincipal') ?? ANONYMOUS_CALLER;
}
