import { expect, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ProviderHealthTable } from './provider-health-table';

const rows = [
  { providerId: 'provider-a', successRate: 0.98, p95LatencyMs: 420 },
  { providerId: 'provider-b', successRate: 0.75, p95LatencyMs: 980 },
];

test('filters Provider diagnostics by visible row values', () => {
  render(<ProviderHealthTable rows={rows} />);

  fireEvent.change(screen.getByRole('textbox', { name: /Filter Provider diagnostics|筛选提供商诊断/u }), {
    target: { value: 'provider-b' },
  });

  const table = screen.getByRole('table', { name: /Provider health|提供商健康状态/u });
  expect(within(table).queryByText('provider-a')).not.toBeInTheDocument();
  expect(within(table).getByText('provider-b')).toBeInTheDocument();
});

test('lets users hide diagnostic columns while keeping all three visible by default', async () => {
  render(<ProviderHealthTable rows={rows} />);

  const table = screen.getByRole('table', { name: /Provider health|提供商健康状态/u });
  expect(within(table).getAllByRole('columnheader')).toHaveLength(3);

  fireEvent.click(screen.getByRole('button', { name: /Columns|列/u }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Success rate|成功率/u }));

  expect(within(table).queryByRole('columnheader', { name: /Success rate|成功率/u })).not.toBeInTheDocument();
  expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
});
