import { expect, test } from 'bun:test';

import { attributeName, spanName } from '../../request-tracing';
import { anthropicRequest, countFixture, provider } from './token-count.test-support';

// The local-estimate fallback and passed-over candidates used to leave no span,
// so a trace answered without any upstream count was indistinguishable from an
// upstream success. These tests pin the attribution spans that replaced the old
// `x-aio-proxy-token-count-estimated` response header.

test('records a local-estimate span when no candidate produces a count', async () => {
  const fixture = countFixture([provider({ id: 'no-count' })]); // no tokenCount capability

  await fixture.anthropic();

  const estimate = fixture.recording.spans.filter((span) => span.name === spanName.tokenCount);
  expect(estimate).toHaveLength(1);
  expect(estimate[0]?.attributes[attributeName.tokenCountSource]).toBe('local_estimate');
});

test('does not record a local-estimate span when a provider answers the count', async () => {
  const fixture = countFixture([provider({ id: 'real', tokenCount: async () => ({ inputTokens: 7 }) })]);

  await fixture.anthropic();

  expect(fixture.recording.spans.filter((span) => span.name === spanName.tokenCount)).toHaveLength(0);
});

test('records a skipped-candidate span with the no_capability reason', async () => {
  const fixture = countFixture([
    provider({ id: 'no-count' }), // skipped: no tokenCount capability
    provider({ id: 'real', tokenCount: async () => ({ inputTokens: 7 }) }),
  ]);

  await fixture.anthropic();

  const skipped = fixture.recording.spans.filter((span) => span.name === spanName.candidateSkipped);
  expect(skipped).toHaveLength(1);
  expect(skipped[0]?.attributes[attributeName.providerId]).toBe('no-count');
  expect(skipped[0]?.attributes[attributeName.skipReason]).toBe('no_capability');
  expect(skipped[0]?.attributes[attributeName.routingContractVersion]).toBe(2);
  expect(skipped[0]?.attributes[attributeName.effectivePriority]).toBe(0);
  expect(skipped[0]?.attributes[attributeName.effectiveWeight]).toBe(1);
  expect(skipped[0]?.attributes[attributeName.prioritySource]).toBe('provider');
  expect(skipped[0]?.attributes[attributeName.weightSource]).toBe('provider');
  expect(skipped[0]?.attributes[attributeName.selectionSource]).toBe('weighted_random');
  // The skipped candidate is attributed as a non-success so the dashboard can
  // surface why the loop advanced past it.
  expect(skipped[0]?.attributes[attributeName.terminationReason]).toBe('failure');
});

test('records a skipped-candidate span with the missing_tool reason', async () => {
  const fixture = countFixture([
    provider({ id: 'no-tool', supportsProviderTool: false, tokenCount: async () => ({ inputTokens: 1 }) }),
    provider({ id: 'capable', supportsProviderTool: true, tokenCount: async () => ({ inputTokens: 9 }) }),
  ]);

  await fixture.anthropic(
    anthropicRequest({ tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] }),
  );

  const skipped = fixture.recording.spans.filter((span) => span.name === spanName.candidateSkipped);
  expect(skipped).toHaveLength(1);
  expect(skipped[0]?.attributes[attributeName.providerId]).toBe('no-tool');
  expect(skipped[0]?.attributes[attributeName.skipReason]).toBe('missing_tool');
});
