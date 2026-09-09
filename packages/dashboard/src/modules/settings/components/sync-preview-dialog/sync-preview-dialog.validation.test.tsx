import type { SyncPreview } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { SyncPreviewDialog } from './sync-preview-dialog';

const preview: SyncPreview = {
  previewId: 'preview-conflict',
  kind: 'join',
  expiresAt: Date.now() + 10_000,
  retainedSharedPlugins: [],
  rows: [
    {
      objectId: 'object-work',
      logicalKey: 'work',
      kind: 'provider',
      change: 'conflict',
      local: { name: 'work' },
      cloud: { name: 'work-cloud' },
      secretChange: 'none',
      dependencies: [],
      choices: ['local', 'cloud'],
    },
  ],
};

const mocks = rs.hoisted(() => ({ applySync: rs.fn() }));

rs.mock('@/lib/sync', () => ({
  SyncRequestError: class SyncRequestError extends Error {},
  useApplySync: () => ({ mutate: mocks.applySync, isPending: false, error: null, reset: rs.fn() }),
}));

interface PreviewStateHarnessProps {
  readonly initialPreview: SyncPreview;
  onPreviewOverrides(paths: readonly string[][]): Promise<SyncPreview>;
}

const PreviewStateHarness: React.FC<PreviewStateHarnessProps> = ({ initialPreview, onPreviewOverrides }) => {
  const [current, setCurrent] = useState(initialPreview);
  const refresh = async (paths: readonly string[][]) => {
    const next = await onPreviewOverrides(paths);
    setCurrent(next);
    return next;
  };
  return <SyncPreviewDialog open preview={current} onOpenChange={rs.fn()} onPreviewOverrides={refresh} />;
};

test('requires a valid replacement Provider ID before applying an identity conflict', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={preview} onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }));

  expect(screen.getByText(/Enter a new Provider ID|请输入新的 Provider ID/u)).toBeTruthy();
  expect(mocks.applySync).not.toHaveBeenCalled();
});

test('applies the preview ID returned after adding an override', async () => {
  mocks.applySync.mockReset();
  const replacement: SyncPreview = {
    ...preview,
    previewId: 'preview-overrides',
    kind: 'overrides',
    rows: [
      {
        ...preview.rows[0]!,
        change: 'update',
        local: { limits: { timeout: 1 } },
        cloud: { limits: { timeout: 2 } },
      },
    ],
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PreviewStateHarness
        initialPreview={preview}
        onPreviewOverrides={async (paths) => {
          expect(paths).toEqual([['limits', 'timeout']]);
          return replacement;
        }}
      />
    </QueryClientProvider>,
  );
  const path = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(path, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));

  await waitFor(() => expect(screen.getAllByText(/timeout/u).length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }));
  expect(mocks.applySync).toHaveBeenCalledWith(
    {
      previewId: 'preview-overrides',
      decisions: [{ objectId: 'object-work', choice: 'local' }],
    },
    { onSuccess: expect.any(Function) },
  );
});

test('keeps purge previews purge-only while the dialog is open', () => {
  mocks.applySync.mockReset();
  const purgePreview: SyncPreview = {
    ...preview,
    previewId: 'preview-purge',
    kind: 'purge',
    rows: [{ ...preview.rows[0]!, change: 'delete', choices: ['local'] }],
  };
  const onPreviewOverrides = rs.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={purgePreview} onOpenChange={rs.fn()} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );

  expect(screen.queryByLabelText(/Option path|选项路径/u)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }));

  expect(onPreviewOverrides).not.toHaveBeenCalled();
  expect(mocks.applySync).toHaveBeenCalledWith(
    { previewId: 'preview-purge', decisions: [{ objectId: 'object-work', choice: 'local' }] },
    { onSuccess: expect.any(Function) },
  );
});

test('keeps submit disabled when an override refresh returns the wrong preview kind', async () => {
  const onPreviewOverrides = rs.fn().mockResolvedValue({ ...preview, previewId: 'preview-purge', kind: 'purge' });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={preview} onOpenChange={rs.fn()} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );

  const path = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(path, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));

  await waitFor(() => expect(screen.getByText(/Could not refresh the preview|无法刷新预览/u)).toBeTruthy());
  expect(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u })).toBeDisabled();
});

test('requests an exact fresh preview after removing a pin and keeps submit disabled until it succeeds', async () => {
  mocks.applySync.mockReset();
  const basePreview: SyncPreview = {
    ...preview,
    previewId: 'preview-base',
    kind: 'join',
    rows: [{ ...preview.rows[0]!, change: 'update', choices: ['local', 'cloud'] }],
  };
  const replacement: SyncPreview = { ...basePreview, previewId: 'preview-overrides', kind: 'overrides' };
  let resolveRemoval!: (value: SyncPreview) => void;
  const removalPromise = new Promise<SyncPreview>((resolve) => {
    resolveRemoval = resolve;
  });
  const onPreviewOverrides = rs.fn();
  onPreviewOverrides.mockImplementation((paths: readonly string[][]): Promise<SyncPreview> =>
    paths.length === 0 ? removalPromise : Promise.resolve(replacement),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PreviewStateHarness initialPreview={basePreview} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );

  const path = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(path, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));
  const remove = await waitFor(() => {
    const button = screen.getByRole('button', { name: /Remove local option.*limits\.timeout/u });
    expect(button).not.toBeDisabled();
    return button;
  });
  const apply = screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u });

  fireEvent.click(remove);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Pending|Apply reviewed changes|应用审核后的变更/u })).toBeDisabled(),
  );
  expect(onPreviewOverrides).toHaveBeenNthCalledWith(2, []);
  await waitFor(() => expect(screen.getByText(/Review the preview again|移除固定项后需要重新审核/u)).toBeTruthy());
  resolveRemoval(replacement);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u })).not.toBeDisabled(),
  );
  expect(apply).toBe(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }));
});

test('retries a failed removal with the same empty override path set', async () => {
  const basePreview: SyncPreview = {
    ...preview,
    previewId: 'preview-base',
    kind: 'join',
    rows: [{ ...preview.rows[0]!, change: 'update', choices: ['local', 'cloud'] }],
  };
  const replacement: SyncPreview = { ...basePreview, previewId: 'preview-overrides', kind: 'overrides' };
  const onPreviewOverrides = rs
    .fn()
    .mockResolvedValueOnce(replacement)
    .mockRejectedValueOnce(new Error('refresh failed'))
    .mockResolvedValueOnce(replacement);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PreviewStateHarness initialPreview={basePreview} onPreviewOverrides={onPreviewOverrides} />
    </QueryClientProvider>,
  );

  const path = screen.getByLabelText(/Option path|选项路径/u);
  fireEvent.change(path, { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));
  const remove = await waitFor(() => {
    const button = screen.getByRole('button', { name: /Remove local option.*limits\.timeout/u });
    expect(button).not.toBeDisabled();
    return button;
  });

  fireEvent.click(remove);
  await waitFor(() => expect(screen.getByText(/Could not refresh the preview|无法刷新预览/u)).toBeTruthy());
  expect(onPreviewOverrides).toHaveBeenNthCalledWith(2, []);
  expect(screen.getByRole('button', { name: /Retry preview|重试预览/u })).not.toBeDisabled();
  expect(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: /Retry preview|重试预览/u }));
  await waitFor(() => expect(onPreviewOverrides).toHaveBeenNthCalledWith(3, []));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u })).not.toBeDisabled(),
  );
});
