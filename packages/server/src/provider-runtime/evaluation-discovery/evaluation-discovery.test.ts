import { describe, expect, it } from 'bun:test';

import { createEvaluationDiscovery, lazyEvaluationTransport } from './evaluation-discovery';

const evaluationModel = () => ({
  specificationVersion: 'v4',
  doEvaluate: async () => ({ answers: {} }),
});

describe('createEvaluationDiscovery', () => {
  it('reports supported when the loaded package exposes evaluationModel', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({ evaluationModel }));
    expect((await discover()).kind).toBe('supported');
  });

  it('reports unsupported when the package genuinely lacks it', async () => {
    const discover = createEvaluationDiscovery('p', async () => ({}));
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
      return { evaluationModel };
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
      return { evaluationModel };
    });
    expect(loads).toBe(0);
  });
});

const invocation = { state: { text: 'hi' }, questions: {} } as const;

describe('lazyEvaluationTransport', () => {
  // The transport is attached before anything is probed, so a cold provider on
  // the first evaluation request of the process must still be dispatchable.
  it('exposes its discovery handle so the attempt layer can await a cold probe', async () => {
    const transport = lazyEvaluationTransport('p', async () => ({ evaluationModel }));
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
      return { evaluationModel };
    });
    await transport.discover();
    await transport.evaluate(invocation, { modelId: 'm' }).catch(() => undefined);
    expect(loads).toBe(1);
  });
});
