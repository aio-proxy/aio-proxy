import { AgentRuntimeError } from '@aio-proxy/agent-provider-runtime';
import type { AgentTokenResponse } from '@aio-proxy/types';

import { readGrokObservation, withGrokInstallation, type GrokContext, type GrokDeadline } from '../grok';
import { beginGrokRefresh, grokRefreshRecoverable, parseGrokCredential, saveGrokToken } from './credential';
import type { GrokAuthDeps, GrokAuthInput, GrokCredential, GrokTransport } from './types';

const NETWORK_HEADROOM_MS = 250;

export class GrokAuthError extends Error {
  constructor(readonly code: 'login_required' | 'deadline' | 'configuration' | 'temporary') {
    super(code === 'login_required' ? 'Grok login required' : `Grok authorization ${code}`);
    this.name = 'GrokAuthError';
  }
}

function networkBudget(budget: GrokDeadline, now: number): GrokDeadline {
  const deadline = budget.deadline - NETWORK_HEADROOM_MS;
  const remaining = deadline - now;
  if (remaining <= 0) {
    throw new GrokAuthError('deadline');
  }
  return {
    deadline,
    signal: AbortSignal.any([budget.signal, AbortSignal.timeout(remaining)]),
  };
}

function grokTokenLine(credential: GrokCredential, now: number): string {
  const expiresIn = Math.floor((credential.accessExpiresAt - now) / 1_000);
  if (credential.status !== 'ready' || expiresIn <= 0) throw new Error('Grok login required');
  return JSON.stringify({ access_token: credential.accessToken, expires_in: expiresIn }) + '\n';
}

async function loginGrokToken(
  context: GrokContext,
  previous: GrokCredential | undefined,
  transport: GrokTransport,
  deps: GrokAuthDeps,
): Promise<GrokCredential> {
  const device = await transport.device(context.marker);
  deps.stderr(device.verification_uri_complete + '\n');
  const token = await transport.poll(context.marker, device);
  return saveGrokToken(context, previous, token, deps.now());
}

async function acquireGrokToken(
  context: GrokContext,
  current: GrokCredential | undefined,
  expired: boolean,
  deps: GrokAuthDeps,
): Promise<GrokCredential> {
  let state = current;
  const invalidate = async (): Promise<void> => {
    if (state === undefined) return;
    state = {
      format: 1,
      agent: 'grok',
      installationId: state.installationId,
      endpoint: state.endpoint,
      revision: state.revision,
      status: 'needs_login',
      accessToken: '',
      refreshToken: '',
      accessExpiresAt: 0,
    };
    await context.writeCredential(state);
  };
  const transportForNetwork = (): GrokTransport =>
    deps.transport(context.marker, networkBudget(context.budget, deps.now()));
  if (state?.status === 'refreshing' && !grokRefreshRecoverable(state, deps.now())) await invalidate();
  if (state !== undefined && state.status !== 'needs_login' && state.refreshToken !== '') {
    const inFlight = await beginGrokRefresh(context, state, deps.now());
    state = inFlight;
    const transport = transportForNetwork();
    let token: AgentTokenResponse;
    try {
      token = await transport.refresh(context.marker, inFlight.refreshToken);
    } catch (error) {
      if (!(error instanceof AgentRuntimeError) || error.code !== 'invalid_grant') throw error;
      await invalidate();
      if (expired) throw new GrokAuthError('login_required');
      return loginGrokToken(context, state, transport, deps);
    }
    return saveGrokToken(context, inFlight, token, deps.now());
  }
  if (expired) throw new GrokAuthError('login_required');
  return loginGrokToken(context, state, transportForNetwork(), deps);
}

export async function grokAuth(input: GrokAuthInput, deps: GrokAuthDeps): Promise<void> {
  const started = deps.now();
  const duration = input.expired ? 5_000 : 240_000;
  const budget: GrokDeadline = { deadline: started + duration, signal: AbortSignal.timeout(duration) };
  const observed = await (deps.readObservation ?? readGrokObservation)(input.root, input.installationId, budget);
  await withGrokInstallation({ ...input, budget, policy: deps.policy }, async (context) => {
    const raw = await context.readCredential();
    const current = raw === undefined ? undefined : parseGrokCredential(raw, context.marker);
    const newerRevision = current !== undefined && current.revision > (observed.revision ?? 0);
    const sameRevisionJoin =
      current !== undefined &&
      current.revision === observed.revision &&
      current.deliveredBy !== undefined &&
      (current.deliveredBy !== observed.deliveredBy || current.deliveredBy === observed.lockOwner);
    // Silent (expired) mode must not reuse the AT that triggered 401 / near-expiry.
    // Same-revision overlap or a new delivery of the observed revision still refreshes.
    const joined = newerRevision || (!input.expired && sameRevisionJoin);
    const credential =
      current?.status === 'ready' && joined && current.accessExpiresAt - deps.now() >= 1_000
        ? current
        : await acquireGrokToken(context, current, input.expired, deps);
    await context.assertRoutingSafe();
    budget.signal.throwIfAborted();
    await context.assertOwnership();
    await deps.stdout(grokTokenLine(credential, deps.now()));
    await context.writeCredential({ ...credential, deliveredBy: context.lockOwner });
  });
}
