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
  const Harness: React.FC = () => {
    const [current, setCurrent] = useState(preview);
    return (
      <SyncPreviewDialog
        open
        preview={current}
        onOpenChange={rs.fn()}
        onPreviewOverrides={async (paths) => {
          setCurrent({
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
          });
          expect(paths).toEqual([['limits', 'timeout']]);
        }}
      />
    );
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
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
