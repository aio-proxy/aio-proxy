import { createProviderV4Evaluate } from '@aio-proxy/core';
import { isRecord } from '@aio-proxy/shared';

import type { EvaluationTransport } from '../../runtime';

/**
 * The outcome of probing a lazily loaded package for an evaluation resolver.
 *
 * Three states, deliberately not a boolean. `unsupported` and `failed` mean
 * opposite things to the caller: the first is a routing fact (this candidate can
 * never serve evaluation convert), the second is a transient attempt failure that
 * must fall back to the next candidate rather than surface as a router miss.
 */
export type EvaluationDiscovery =
  | { readonly kind: 'supported'; readonly evaluate: EvaluationTransport['evaluate'] }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly error: Error };

/**
 * Probe a lazily loaded AI SDK package for `evaluationModel`, once.
 *
 * A probe result describes the CONVERT transport only. It is never a verdict on
 * the candidate: a provider with a matching System One raw endpoint stays
 * eligible whatever this returns, and must not wait on it.
 *
 * The probe cannot run where the capability index is built. `createAiSdkProvider`
 * is synchronous and hands back a wrapper; the real package arrives through an
 * async memoized task, and `materializeRuntimeProvider` is synchronous too. So
 * the package object simply does not exist yet at index time — hence a lazy,
 * memoized probe at the first async boundary that needs the answer.
 */
export function createEvaluationDiscovery(
  providerId: string,
  loadProvider: () => Promise<unknown>,
): () => Promise<EvaluationDiscovery> {
  let pending: Promise<EvaluationDiscovery> | undefined;
  return () => {
    // Memoized on the PROMISE, not the result: concurrent first callers must
    // share one load, and a failure must stay decided rather than re-importing
    // a missing package on every subsequent request.
    pending ??= probe(providerId, loadProvider);
    return pending;
  };
}

async function probe(providerId: string, loadProvider: () => Promise<unknown>): Promise<EvaluationDiscovery> {
  try {
    const provider = await loadProvider();
    // `loadAiSdkProvider` resolves null for a package it could not install. That
    // is a load failure, not a package that genuinely lacks the resolver.
    if (provider === null || provider === undefined) {
      return { kind: 'failed', error: new Error(`Provider ${providerId} could not load its AI SDK package`) };
    }
    if (!isRecord(provider) || typeof provider['evaluationModel'] !== 'function') {
      return { kind: 'unsupported' };
    }
    // Constructed inside the try: the factory throws SYNCHRONOUSLY when the
    // resolver is missing, and that throw must not escape into the candidate loop.
    return { kind: 'supported', evaluate: createProviderV4Evaluate(providerId, provider).evaluate };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** An `EvaluationTransport` that also exposes the probe backing it. */
export type LazyEvaluationTransport = EvaluationTransport & {
  readonly discover: () => Promise<EvaluationDiscovery>;
};

/**
 * Attach-time transport for a package that has not been loaded yet.
 *
 * `discover` is public because admission and dispatch need the same probe:
 * treating "not yet probed" as unsupported would filter out a cold candidate on
 * the first evaluation request of the process, and treating the mere presence of
 * this wrapper as proof would admit packages whose real provider has no resolver.
 */
export function lazyEvaluationTransport(providerId: string, loadProvider: () => Promise<unknown>) {
  const discover = createEvaluationDiscovery(providerId, loadProvider);
  return {
    discover,
    async evaluate(invocation, options) {
      const discovered = await discover();
      if (discovered.kind === 'failed') throw discovered.error;
      if (discovered.kind === 'unsupported') {
        throw new TypeError(`Provider ${providerId} exposes no evaluation model resolver`);
      }
      return discovered.evaluate(invocation, options);
    },
  } satisfies LazyEvaluationTransport;
}
