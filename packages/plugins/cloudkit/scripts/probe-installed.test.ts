import { describe, expect, test } from 'bun:test';

import { parseProbeResult } from './probe-installed';

describe('installed CloudKit probe output', () => {
  test('accepts only the redacted success contract', () => {
    expect(
      parseProbeResult(
        JSON.stringify({
          ok: true,
          account: 'available',
          identityId: 'sha256:abc',
          bundleId: 'dev.aioproxy',
        }),
      ),
    ).toEqual({
      ok: true,
      account: 'available',
      identityId: 'sha256:abc',
      bundleId: 'dev.aioproxy',
    });
  });

  test('rejects native output that contains an unstructured error', () => {
    expect(() => parseProbeResult('{"ok":false,"error":"secret"}')).toThrow('structured probe error');
  });
});
