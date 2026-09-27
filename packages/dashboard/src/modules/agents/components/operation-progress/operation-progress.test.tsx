import type { AgentOperationState } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { OperationProgress } from './operation-progress';

const base = { operationId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c', target: 'codex', kind: 'configure' } as const;

test('an operation awaiting approval shows the device code and routes each decision', () => {
  const onDecide = rs.fn();
  const state: AgentOperationState = {
    ...base,
    status: 'awaiting_approval',
    installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
    userCode: 'ABCD-EFGH',
    expiresAt: '2026-09-26T00:10:00.000Z',
  };
  render(<OperationProgress state={state} onDecide={onDecide} deciding={false} />);
  expect(screen.getAllByText(/ABCD-EFGH/u).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: /Approve|批准/u }));
  fireEvent.click(screen.getByRole('button', { name: /Deny|拒绝/u }));
  expect(onDecide.mock.calls).toEqual([['approve'], ['deny']]);
});

test('a failed operation explains the closed error code', () => {
  render(
    <OperationProgress
      state={{ ...base, status: 'failed', error: 'plan_stale' }}
      onDecide={rs.fn()}
      deciding={false}
    />,
  );
  expect(screen.getByRole('alert').textContent).toMatch(/Codex/u);
});

test.each([
  ['blocked', /could not be revoked|无法撤销/u],
  ['partial', /model_providers\.aio-proxy\.name/u],
] as const)('an incomplete %s removal is reported, not shown as done', (status, message) => {
  render(
    <OperationProgress
      state={{
        ...base,
        kind: 'remove',
        status: 'succeeded',
        result: {
          target: 'codex',
          status,
          preservedPaths: ['model_providers.aio-proxy.name'],
          revokeStatus: 'pending',
        },
      }}
      onDecide={rs.fn()}
      deciding={false}
    />,
  );
  expect(screen.getByRole('alert').textContent).toMatch(message);
  expect(screen.queryByText(/^(Done\.|已完成。)$/u)).toBeNull();
});

test('a configure whose session migration stopped part-way is reported as incomplete', () => {
  render(
    <OperationProgress
      state={{
        ...base,
        status: 'succeeded',
        result: {
          target: 'codex',
          status: 'configured',
          migration: { status: 'partial', migrated: 1, skipped: 0, conflicts: 2 },
        },
      }}
      onDecide={rs.fn()}
      deciding={false}
    />,
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByTestId('operation-result').textContent).toMatch(/1 moved, 2 conflicts|已迁移 1 个，2 个冲突/u);
});
