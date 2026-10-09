import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart, ENDED_AT } from '../trace-store.test-support';

for (const backup of [false, true]) {
  test(`persists consumed refusal usage without changing request counts or Provider attribution (${backup ? 'fallback' : 'terminal'})`, () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const usage = {
        providerId: 'decisions',
        modelId: 'judge',
        inputTokens: 100,
        outputTokens: 0,
        totalTokens: 100,
        estimatedCostUsd: 0.1,
        priceSource: 'config',
      };
      const input = completion({
        spans: [
          rootSpan(),
          attemptSpan({
            attributes: {
              'aio_proxy.attempt.index': 0,
              'aio_proxy.provider.id': 'decisions',
              'gen_ai.request.model': 'judge',
              'aio_proxy.termination.reason': 'failure',
              'aio_proxy.usage.consumed': true,
              'gen_ai.usage.input_tokens': usage.inputTokens,
              'gen_ai.usage.output_tokens': usage.outputTokens,
              'gen_ai.usage.total_tokens': usage.totalTokens,
              'gen_ai.usage.estimated_cost_usd': usage.estimatedCostUsd,
            },
          }),
        ],
        summary: backup
          ? {
              finalProviderId: 'backup',
              finalModelId: 'judge',
              finalHttpStatus: 200,
              usage: {
                providerId: 'backup',
                modelId: 'judge',
                inputTokens: 20,
                outputTokens: 10,
                totalTokens: 30,
                estimatedCostUsd: 0.2,
              },
            }
          : { finalProviderId: 'decisions', finalModelId: 'judge', finalHttpStatus: 501, terminationReason: 'failure' },
      });
      store.startRoot(rootStart());
      expect(store.complete(input)).toBe(true);
      expect(store.complete(input)).toBe(false);
      const start = new Date(ENDED_AT.getTime() - 1000);
      expect(store.providerWindowCost({ providerId: 'decisions', start, end: ENDED_AT })).toBe('100000000');
      expect(store.providerWindowCost({ providerId: 'backup', start, end: ENDED_AT })).toBe(
        backup ? '200000000' : undefined,
      );
      const overview = store.overview({ range: '24h', groupBy: 'provider', metric: 'cost', now: ENDED_AT });
      expect(overview.summary).toMatchObject({
        requestCount: '1',
        inputTokens: backup ? '120' : '100',
        totalTokens: backup ? '130' : '100',
        estimatedCostNanoUsd: backup ? '300000000' : '100000000',
        successCount: backup ? '1' : '0',
        failureCount: backup ? '0' : '1',
      });
      for (const range of ['24h', '7d'] as const) {
        expect(store.overviewDashboard({ range, now: ENDED_AT }).summary.current).toMatchObject({
          requestCount: '1',
          totalTokens: backup ? '130' : '100',
          estimatedCostNanoUsd: backup ? '300000000' : '100000000',
        });
        const desktop = store.desktopUsage({ range, now: ENDED_AT });
        expect(desktop.current).toMatchObject({
          requests: '1',
          inputTokens: backup ? '120' : '100',
          estimatedCostNanoUsd: backup ? '300000000' : '100000000',
        });
        expect(desktop.byProvider.find((row) => row.providerId === 'decisions')).toMatchObject({
          totalTokens: '100',
          estimatedCostNanoUsd: '100000000',
        });
        const diagnostics = store.overviewDashboardDiagnostics({ range, now: ENDED_AT });
        expect(diagnostics.topModelCosts.reduce((sum, row) => sum + BigInt(row.estimatedCostNanoUsd), 0n)).toBe(
          backup ? 300000000n : 100000000n,
        );
        expect(diagnostics.providerHealth?.find((row) => row.providerId === 'decisions')).toMatchObject({
          totalTokens: '100',
          successRate: 0,
        });
      }
    } finally {
      handle.close();
    }
  });
}
