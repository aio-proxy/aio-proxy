import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceStatus } from './trace-status';

const endedAt = '2026-07-28T08:00:01.000Z';

test.each([
  {
    name: 'running takes precedence while the item has not ended',
    item: { endedAt: null, otelStatusCode: 'ERROR' as const, terminationReason: 'failure' as const },
    label: /Running|运行中/u,
    status: 'running',
    presentationClass: 'bg-sky-50',
  },
  {
    name: 'completed UNSET is successful',
    item: { endedAt, otelStatusCode: 'UNSET' as const },
    label: /Success|成功/u,
    status: 'success',
    presentationClass: 'bg-teal-50',
  },
  {
    name: 'failure termination is destructive',
    item: { endedAt, otelStatusCode: 'UNSET' as const, terminationReason: 'failure' as const },
    label: /Failure|失败/u,
    status: 'failure',
    presentationClass: 'text-destructive',
  },
  {
    name: 'cancellation is neutral',
    item: { endedAt, otelStatusCode: 'UNSET' as const, terminationReason: 'cancelled' as const },
    label: /Cancelled|已取消/u,
    status: 'cancelled',
    presentationClass: 'border-border',
  },
  {
    name: 'interruption is neutral',
    item: { endedAt, otelStatusCode: 'UNSET' as const, terminationReason: 'interrupted' as const },
    label: /Interrupted|已中断/u,
    status: 'interrupted',
    presentationClass: 'border-border',
  },
  {
    name: 'OTel ERROR without a termination reason is failure',
    item: { endedAt, otelStatusCode: 'ERROR' as const },
    label: /Failure|失败/u,
    status: 'failure',
    presentationClass: 'text-destructive',
  },
])('$name', ({ item, label, status, presentationClass }) => {
  render(<TraceStatus item={item} />);

  const badge = screen.getByText(label);
  expect(badge).toHaveAttribute('data-status', status);
  expect(badge).toHaveClass(presentationClass);
});
