import { describe, expect, it } from 'bun:test';

import { createAnthropic } from '@ai-sdk/anthropic';

import { createEvaluationDiscovery, lazyEvaluationTransport } from './evaluation-discovery';

const evaluationModel = () => ({
  specificationVersion: 'v4',
  doEvaluate: async () => ({ answers: {} }),
});

/**
 * The default double is CALLABLE, because every real AI SDK provider factory
 * returns a function carrying its resolvers. A plain-object double cannot fail
 * an object-only guard, so it silently certifies a probe that reports every real
 * package unsupported.
 */
const callableProvider = () => Object.assign(() => undefined, { evaluationModel });

describe('createEvaluationDiscovery', () => {
  it('reports supported when the loaded package exposes evaluationModel', async () => {
    const discover = createEvaluationDiscovery('p', async () => callableProvider());
    expect((await discover()).kind).toBe('supported');
  });

  // Not every provider is callable — a hand-rolled or wrapped one may be a plain
  // object — so the guard must keep admitting that shape too.
  it('reports supported for a plain-object provider as well', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({ evaluationModel }));
    expect((await discover()).kind).toBe('supported');
  });

  // The regression this whole guard exists for. `@ai-sdk/anthropic` is the real
  // package, not a shape guess: an object-only check reports it unsupported and
  // memoizes that, which turns evaluation routing off in production while every
  // plain-object double above stays green.
  it('reports supported for a real @ai-sdk/anthropic provider', async () => {
    const provider = createAnthropic({ apiKey: 'test' });
    expect(typeof provider).toBe('function');

    const discover = createEvaluationDiscovery('anthropic', async () => provider);
    expect((await discover()).kind).toBe('supported');
  });

  it('reports unsupported when the package genuinely lacks it', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({}));
    expect((await discover()).kind).toBe('unsupported');
  });

  // A callable that resolves no evaluation model is still unsupported: accepting
  // functions must not degrade into accepting anything callable.
  it('reports unsupported for a callable package without the resolver', async () => {
    const discover = createEvaluationDiscovery('p', async () =>
      Object.assign(() => undefined, { languageModel: () => undefined }),
    );
    expect((await discover()).kind).toBe('unsupported');
  });

  // A missing install is a candidate failure that falls back, never a router miss.
  // Collapsing it into `unsupported` makes the pipeline answer "no provider
  // supports this model" for a provider that is merely uninstalled.
  it('reports failed rather than unsupported when the package cannot load', async () => {
    const discover = createEvaluationDiscovery('p', async () => {
      throw new Error('ProviderNotInstalledError: @ai-sdk/nope');
    });
    const result = await discover();
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.error.message).toContain('ProviderNotInstalled');
  });

  it('reports failed when the loader resolves null for an uninstalled package', async () => {
    const discover = createEvaluationDiscovery('p', async () => null);
    expect((await discover()).kind).toBe('failed');
  });

  // `createProviderV4Evaluate` throws synchronously when the package exposes no
  // resolver, so construction must happen inside the probe's try.
  it('reports failed rather than throwing when the resolver is present but unusable', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({
      get evaluationModel(): unknown {
        throw new Error('exploding getter');
      },
    }));
    expect((await discover()).kind).toBe('failed');
  });

  it('rejects a non-function evaluationModel as unsupported', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({ evaluationModel: 'nope' }));
    expect((await discover()).kind).toBe('unsupported');
  });

  it('loads once and memoizes, including across concurrent callers', async () => {
    let loads = 0;
    const discover = createEvaluationDiscovery('p', async () => {
      loads += 1;
      return callableProvider();
    });
    await Promise.all([discover(), discover(), discover()]);
    await discover();
    expect(loads).toBe(1);
  });

  it('memoizes a failure instead of retrying the load on every request', async () => {
    let loads = 0;
    const discover = createEvaluationDiscovery('p', async () => {
      loads += 1;
      throw new Error('boom');
    });
    await discover();
    await discover();
    expect(loads).toBe(1);
  });

  // Discovery must not run at materialization: importing every configured
  // package at startup turns a slow or missing install into a boot failure.
  it('does not load the package until the first probe', () => {
    let loads = 0;
    createEvaluationDiscovery('p', async () => {
      loads += 1;
      return callableProvider();
    });
    expect(loads).toBe(0);
  });
});

const invocation = { state: { text: 'hi' }, questions: {} } as const;

describe('lazyEvaluationTransport', () => {
  // The transport is attached before anything is probed, so a cold provider on
  // the first evaluation request of the process must still be dispatchable.
  it('exposes its discovery handle so the attempt layer can await a cold probe', async () => {
    const transport = lazyEvaluationTransport('p', async () => callableProvider());
    expect((await transport.discover()).kind).toBe('supported');
  });

  it('rejects with the load error so the attempt becomes a candidate failure', async () => {
    const transport = lazyEvaluationTransport('p', async () => {
      throw new Error('ProviderNotInstalledError: @ai-sdk/nope');
    });
    await expect(transport.evaluate(invocation, { modelId: 'm' })).rejects.toThrow(/ProviderNotInstalled/);
  });

  it('rejects when the package exposes no evaluation resolver', async () => {
    const transport = lazyEvaluationTransport('p', async () => ({}));
    await expect(transport.evaluate(invocation, { modelId: 'm' })).rejects.toThrow(/evaluation/);
  });

  it('shares one probe between evaluate and discover', async () => {
    let loads = 0;
    const transport = lazyEvaluationTransport('p', async () => {
      loads += 1;
      return callableProvider();
    });
    await transport.discover();
    await transport.evaluate(invocation, { modelId: 'm' }).catch(() => undefined);
    expect(loads).toBe(1);
  });
});
