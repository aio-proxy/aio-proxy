import type { SyncPreview } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

const previewWithSecretAdded: SyncPreview = {
  ...preview,
  rows: [{ ...preview.rows[0]!, secretChange: 'added' }],
};

test('renders redacted values and plugin retention without a second secret consent toggle', () => {
  renderDialog();
  expect(screen.getAllByText(/redacted/u).length).toBeGreaterThan(1);
  expect(screen.getByText(/Shared plugin data will remain|共享插件数据会保留/u)).toBeTruthy();
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
});

test('discloses required plugin data when a preview adds a secret without dependencies', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={previewWithSecretAdded} onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  expect(
    screen.getByText(/Required plugin settings and secrets are included|会包含必需的插件设置和密钥/u),
  ).toBeTruthy();
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

test('requests a new overrides preview when pinning a local option', async () => {
  const replacement: SyncPreview = {
    ...preview,
    previewId: 'preview-overrides',
    kind: 'overrides',
  };
  const onPreviewOverrides = rs.fn().mockResolvedValue(replacement);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={preview} onOpenChange={rs.fn()} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );
  const path = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(path, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));

  await waitFor(() => expect(onPreviewOverrides).toHaveBeenCalledWith('object-work', [['limits', 'timeout']]));
});

test('pins a local option on the row it was entered under, not the first row', async () => {
  const twoRows: SyncPreview = {
    ...preview,
    rows: [preview.rows[0]!, { ...preview.rows[0]!, objectId: 'object-home', logicalKey: 'home' }],
  };
  const onPreviewOverrides = rs
    .fn()
    .mockResolvedValue({ ...twoRows, previewId: 'preview-overrides', kind: 'overrides' });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={twoRows} onOpenChange={rs.fn()} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );
  const paths = screen.getAllByLabelText(/Option path|选项路径/u);
  fireEvent.change(paths[1]!, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getAllByRole('button', { name: /Pin local option|固定本地选项/u })[1]!);

  await waitFor(() => expect(onPreviewOverrides).toHaveBeenCalledWith('object-home', [['limits', 'timeout']]));
});

test('clears override paths when closing before reopening a new preview', async () => {
  const replacement: SyncPreview = { ...preview, previewId: 'preview-overrides', kind: 'overrides' };
  const onPreviewOverrides = rs.fn().mockResolvedValue(replacement);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={preview} onOpenChange={rs.fn()} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );

  const path = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(path, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));
  await waitFor(() => expect(onPreviewOverrides).toHaveBeenNthCalledWith(1, 'object-work', [['limits', 'timeout']]));

  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open={false} preview={null} onOpenChange={rs.fn()} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog
        open
        preview={{ ...preview, previewId: 'preview-reopen' }}
        onOpenChange={rs.fn()}
        onPreviewOverrides={onPreviewOverrides}
      />
    </QueryClientProvider>,
  );

  const reopenedPath = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(reopenedPath, { target: { value: 'models.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));
  await waitFor(() => expect(onPreviewOverrides).toHaveBeenNthCalledWith(2, 'object-work', [['models', 'timeout']]));
});

test('applies an empty first-connect preview', () => {
  const connectPreview: SyncPreview = { ...preview, previewId: 'preview-connect', kind: 'connect', rows: [] };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={connectPreview} onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  expect(
    screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }).hasAttribute('disabled'),
  ).toBe(false);
});

test('keeps apply disabled for an empty decision-bearing preview', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={{ ...preview, rows: [] }} onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  expect(
    screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }).hasAttribute('disabled'),
  ).toBe(true);
});
