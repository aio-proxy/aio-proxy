import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import type { TraceHopChip } from '../../lib/trace-hops';
import { TraceHopSelector } from './trace-hop-selector';

const attempt = (label: string, attemptIndex: number, status: TraceHopChip['status']): TraceHopChip => ({
  id: `attempt-${attemptIndex}`,
  label,
  kind: 'attempt',
  attemptIndex,
  sendIndex: undefined,
  status,
});

const FAILED = /Failure|失败|失敗|실패/u;
const SUCCEEDED = /Success|成功|성공/u;

test('says which hop failed instead of leaving it to the dot color', () => {
  // 失败转移：两颗 chip 的可读名字必须能分开，否则读屏用户听到的是两个一模一样的按钮。
  render(
    <TraceHopSelector
      hops={[attempt('anthropic-primary', 0, 'failure'), attempt('anthropic-backup', 1, 'success')]}
      selectedHopId="attempt-0"
      onSelect={rs.fn()}
    />,
  );

  expect(screen.getByRole('button', { name: /anthropic-primary/u })).toHaveAccessibleName(FAILED);
  expect(screen.getByRole('button', { name: /anthropic-backup/u })).toHaveAccessibleName(SUCCEEDED);
  expect(screen.getByRole('button', { name: /anthropic-backup/u })).not.toHaveAccessibleName(FAILED);
});

// 「不是失败就念成功」正是这次要去掉的谎：还在跑和已取消两态都不许借用成功的说法或颜色。
test('does not announce running or cancelled hops as successful', () => {
  render(
    <TraceHopSelector
      hops={[attempt('still-running', 0, 'running'), attempt('user-cancelled', 1, 'cancelled')]}
      selectedHopId="attempt-0"
      onSelect={rs.fn()}
    />,
  );

  for (const label of [/still-running/u, /user-cancelled/u]) {
    const button = screen.getByRole('button', { name: label });
    expect(button).not.toHaveAccessibleName(SUCCEEDED);
    expect(button).not.toHaveAccessibleName(FAILED);
    // 圆点也不能借成功色 —— 颜色是这排 chip 上除读屏文案外唯一的载体。
    expect(button.querySelector('.bg-chart-success')).toBeNull();
  }
});
