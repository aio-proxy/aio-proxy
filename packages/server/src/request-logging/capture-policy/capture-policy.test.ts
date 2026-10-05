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

test('retains fixed body rejection diagnostics while removing sensitive values', () => {
  const safe = {
    bodyLimitStage: 'encoded',
    bodyLimitBytes: 8,
    bodyMeasurement: 'observed_lower_bound',
    bodyBytes: 9,
    bodyRejectReason: 'invalid_content_length',
    bodyContentEncoding: 'unsupported',
  };
  expect(
    safeDiagnosticFields({
      ...safe,
      body: 'private-input',
      headers: 'private-input',
      errorMessage: 'private-input native zlib error',
      url: 'https://private-input',
      [attributeName.bodyLimitStage]: 'decoded',
      [attributeName.bodyMeasurement]: 'unknown',
      [attributeName.bodyLimitBytes]: 8,
    }),
  ).toEqual({
    ...safe,
    [attributeName.bodyLimitStage]: 'decoded',
    [attributeName.bodyMeasurement]: 'unknown',
    [attributeName.bodyLimitBytes]: 8,
  });
  expect(
    safeDiagnosticFields({
      bodyLimitStage: 'private-input',
      bodyMeasurement: 'private-input',
      bodyContentEncoding: 'gzip, private-input',
      bodyRejectReason: 'private-input',
      bodyLimitBytes: Infinity,
      bodyBytes: NaN,
    }),
  ).toEqual({});
});

test('rejects wrong types for body enum and size diagnostics', () => {
  expect(
    safeDiagnosticFields({
      bodyLimitStage: 1,
      bodyMeasurement: true,
      bodyContentEncoding: false,
      bodyRejectReason: 2,
      bodyBytes: true,
      bodyLimitBytes: '8',
      [attributeName.bodyBytes]: false,
    }),
  ).toEqual({});
});
