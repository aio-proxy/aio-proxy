import type { SyncPreview } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';

import { SyncPreviewDialog } from './sync-preview-dialog';

const preview: SyncPreview = {
  previewId: 'preview-1',
  kind: 'join',
  expiresAt: Date.now() + 10_000,
  retainedSharedPlugins: ['@aio-proxy/plugin-cloudkit'],
  rows: [
    {
      objectId: 'object-work',
      logicalKey: 'work',
      kind: 'provider',
      change: 'conflict',
      local: { name: 'work', apiKey: 'local-secret' },
      cloud: { name: 'work-old', apiKey: 'cloud-secret' },
      secretChange: 'changed',
      dependencies: [],
      choices: ['local', 'cloud'],
    },
  ],
};

const renderDialog = (onOpenChange = rs.fn()) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={preview} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );

test('renders redacted values and plugin retention without a second secret consent toggle', () => {
  renderDialog();
  expect(screen.getAllByText(/redacted/u).length).toBeGreaterThan(1);
  expect(screen.getByText(/Shared plugin data will remain|共享插件数据会保留/u)).toBeTruthy();
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
});

test('removing a local override requires a fresh preview before submit', () => {
  renderDialog();
  const path = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(path, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));
  fireEvent.click(screen.getByRole('button', { name: /limits\.timeout/u }));
  expect(screen.getByText(/Review the preview again|移除固定项后需要重新审核/u)).toBeTruthy();
  expect(
    screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }).hasAttribute('disabled'),
  ).toBe(true);
});
