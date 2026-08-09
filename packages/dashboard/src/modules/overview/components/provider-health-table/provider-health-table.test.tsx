import { expect, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';

import { ProviderHealthTable } from './provider-health-table';

const rows = [
  { providerId: 'provider-a', successRate: 0.98, p95LatencyMs: 420 },
  { providerId: 'provider-b', successRate: 0.75, p95LatencyMs: 980 },
];

test('renders Provider health rows with client table controls', () => {
  render(<ProviderHealthTable rows={rows} />);

  expect(screen.getByRole('textbox', { name: /Filter providers|筛选提供商/u })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Provider columns|提供商列/u })).toBeInTheDocument();

  const table = screen.getByRole('table', { name: /Provider health|提供商健康状况/u });
  expect(within(table).getByText('provider-a')).toBeInTheDocument();
  expect(within(table).getByText('provider-b')).toBeInTheDocument();
  expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
});
