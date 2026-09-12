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

rs.mock('@/hooks/use-sync', () => ({
  useApplySync: () => ({ mutate: mocks.applySync, isPending: false, error: null, reset: rs.fn() }),
}));

const noop = () => {};

interface PreviewStateHarnessProps {
  readonly initialPreview: SyncPreview;
  onPreviewOverrides(objectId: string, paths: readonly string[][]): Promise<SyncPreview>;
  onRetry?(): Promise<SyncPreview>;
  onOpenChange?(open: boolean): void;
}

const PreviewStateHarness: React.FC<PreviewStateHarnessProps> = ({
  initialPreview,
  onPreviewOverrides,
  onRetry,
  onOpenChange,
}) => {
  const [current, setCurrent] = useState(initialPreview);
  const refresh = async (objectId: string, paths: readonly string[][]) => {
    const next = await onPreviewOverrides(objectId, paths);
    setCurrent(next);
    return next;
  };
  const retry =
    onRetry === undefined
      ? undefined
      : async () => {
          const next = await onRetry();
          setCurrent(next);
          return next;
        };
  return (
    <SyncPreviewDialog
      preview={current}
      onOpenChange={onOpenChange ?? noop}
      onRetry={retry}
      onPreviewOverrides={refresh}
    />
  );
};

test('requires a valid replacement Provider ID before applying an identity conflict', async () => {
  mocks.applySync.mockReset();
  const collision: SyncPreview = {
    ...preview,
    rows: [{ ...preview.rows[0]!, requiresProviderId: true }],
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={collision} onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }));

  await waitFor(() => expect(screen.getByText(/Enter a new Provider ID|请输入新的 Provider ID/u)).toBeTruthy());
  expect(mocks.applySync).not.toHaveBeenCalled();
});

test('applies a same-object Provider conflict under its existing ID', async () => {
  mocks.applySync.mockReset();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={preview} onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  expect(screen.queryByLabelText(/New Provider ID|新的 Provider ID/u)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }));

  await waitFor(() =>
    expect(mocks.applySync).toHaveBeenCalledWith(
      { previewId: 'preview-conflict', decisions: [{ objectId: 'object-work', choice: 'local' }] },
      { onSuccess: expect.any(Function) },
    ),
  );
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
        onPreviewOverrides={async (_objectId, paths) => {
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
  await waitFor(() =>
    expect(mocks.applySync).toHaveBeenCalledWith(
      {
        previewId: 'preview-overrides',
        decisions: [{ objectId: 'object-work', choice: 'local' }],
      },
      { onSuccess: expect.any(Function) },
    ),
  );
});

test('brings the join operation back instead of closing after applying a pinned override', async () => {
  mocks.applySync.mockReset();
  const overridesPreview: SyncPreview = { ...preview, previewId: 'preview-overrides', kind: 'overrides' };
  const onRetry = rs.fn().mockResolvedValue({ ...preview, previewId: 'preview-join-refreshed' });
  const onOpenChange = rs.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PreviewStateHarness
        initialPreview={preview}
        onPreviewOverrides={async () => overridesPreview}
        onRetry={onRetry}
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );

  fireEvent.change(screen.getByLabelText(/Option path|选项路径/u), { target: { value: 'limits.timeout' } });
  fireEvent.click(screen.getByRole('button', { name: /Pin local option|固定本地选项/u }));
  const apply = await waitFor(() => {
    const button = screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u });
    expect(button).not.toBeDisabled();
    return button;
  });

  fireEvent.click(apply);
  await waitFor(() => expect(mocks.applySync).toHaveBeenCalledTimes(1));
  const [applyInput, handlers] = mocks.applySync.mock.calls[0] as [{ previewId: string }, { onSuccess(): void }];
  expect(applyInput.previewId).toBe('preview-overrides');
  handlers.onSuccess();

  // The join decisions were never sent, so the dialog owes the user a second explicit apply.
  await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
  await waitFor(() => expect(screen.queryByRole('button', { name: /Remove local option/u })).toBeNull());
});

test('keeps purge previews purge-only while the dialog is open', async () => {
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
  await waitFor(() =>
    expect(mocks.applySync).toHaveBeenCalledWith(
      { previewId: 'preview-purge', decisions: [{ objectId: 'object-work', choice: 'local' }] },
      { onSuccess: expect.any(Function) },
    ),
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
  onPreviewOverrides.mockImplementation((_objectId: string, paths: readonly string[][]): Promise<SyncPreview> =>
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
  expect(onPreviewOverrides).toHaveBeenNthCalledWith(2, 'object-work', []);
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
  expect(onPreviewOverrides).toHaveBeenNthCalledWith(2, 'object-work', []);
  expect(screen.getByRole('button', { name: /Retry preview|重试预览/u })).not.toBeDisabled();
  expect(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: /Retry preview|重试预览/u }));
  await waitFor(() => expect(onPreviewOverrides).toHaveBeenNthCalledWith(3, 'object-work', []));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u })).not.toBeDisabled(),
  );
});

test('a connect preview leaves an optional row out of the decisions until the user opts in', async () => {
  mocks.applySync.mockReset();
  const row = (objectId: string, logicalKey: string, extra: Partial<SyncPreview['rows'][number]>) => ({
    objectId,
    logicalKey,
    kind: 'provider',
    change: 'add' as const,
    local: null,
    cloud: null,
    secretChange: 'none' as const,
    dependencies: [],
    choices: [] as SyncPreview['rows'][number]['choices'],
    ...extra,
  });
  const connect: SyncPreview = {
    previewId: 'preview-connect',
    kind: 'connect',
    expiresAt: Date.now() + 10_000,
    retainedSharedPlugins: [],
    rows: [
      row('carried', 'work', { local: { name: 'work' }, choices: ['local'], optional: true }),
      row('cloud-only', 'shared', { cloud: { name: 'shared' }, choices: ['cloud'] }),
    ],
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SyncPreviewDialog open preview={connect} onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );

  // The carried row offers only `local`, so preselecting its first choice would republish every
  // Provider, rule and secret to the candidate backend the moment Apply is pressed.
  expect(screen.getByLabelText('work').textContent).toMatch(/Don't join|不加入|参加しない|참여 안 함/u);
  fireEvent.click(screen.getByRole('button', { name: /Apply reviewed changes|应用审核后的变更/u }));

  await waitFor(() =>
    expect(mocks.applySync).toHaveBeenCalledWith(
      { previewId: 'preview-connect', decisions: [{ objectId: 'cloud-only', choice: 'cloud' }] },
      { onSuccess: expect.any(Function) },
    ),
  );
});
