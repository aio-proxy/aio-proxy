import { expect, test } from '@rstest/core';

import { providerStub } from '@/lib/provider-fixtures';

import { providerDisplayName } from './provider-display-name';

test('prefers the configured name, then the account label, then the Provider ID', () => {
  expect(providerDisplayName(providerStub({ id: 'kimi', name: 'Kimi', accountLabel: 'a@b.com' }))).toBe('Kimi');
  expect(providerDisplayName(providerStub({ id: 'kimi', accountLabel: 'a@b.com' }))).toBe('a@b.com');
  expect(providerDisplayName(providerStub({ id: 'kimi' }))).toBe('kimi');
});
