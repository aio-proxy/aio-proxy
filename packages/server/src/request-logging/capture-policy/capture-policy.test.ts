import { expect, test } from 'bun:test';

import { attributeName } from '../../request-tracing/semantic';
import { safeDiagnosticFields } from './capture-policy';

// With payload capture off every span is sensitive, so this filter is what decides whether the trace
// can still say which Providers routing skipped and why.
test('keeps the skipped-candidate list when every entry is a Provider ID and a known reason', () => {
  const entries = ['sub-a:quota_exhausted', 'team/sub.b:cooldown'];
  expect(safeDiagnosticFields({ [attributeName.routeSkippedCandidates]: entries })).toEqual({
    [attributeName.routeSkippedCandidates]: entries,
  });
});

test('drops the skipped-candidate list when an entry does not match the shape', () => {
  expect(
    safeDiagnosticFields({ [attributeName.routeSkippedCandidates]: ['sub-a:quota_exhausted', 'sub-b:other'] }),
  ).toEqual({});
});

test('drops arrays under any other key', () => {
  expect(safeDiagnosticFields({ [attributeName.providerId]: ['sub-a:cooldown'] })).toEqual({});
});
