import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import type { TraceHopChip } from '../../lib/trace-hops';
import { TraceHopSelector } from './trace-hop-selector';

const attempt = (label: string, attemptIndex: number, failed: boolean): TraceHopChip => ({
  id: `attempt-${attemptIndex}`,
  label,
  kind: 'attempt',
  attemptIndex,
  failed,
});

const FAILED = /Failure|失败|失敗|실패/u;
const SUCCEEDED = /Success|成功|성공/u;

test('says which hop failed instead of leaving it to the dot color', () => {
  // 失败转移：两颗 chip 的可读名字必须能分开，否则读屏用户听到的是两个一模一样的按钮。
  render(
    <TraceHopSelector
      hops={[attempt('anthropic-primary', 0, true), attempt('anthropic-backup', 1, false)]}
      selectedHopId="attempt-0"
      onSelect={rs.fn()}
    />,
  );

  expect(screen.getByRole('button', { name: /anthropic-primary/u })).toHaveAccessibleName(FAILED);
  expect(screen.getByRole('button', { name: /anthropic-backup/u })).toHaveAccessibleName(SUCCEEDED);
  expect(screen.getByRole('button', { name: /anthropic-backup/u })).not.toHaveAccessibleName(FAILED);
});
