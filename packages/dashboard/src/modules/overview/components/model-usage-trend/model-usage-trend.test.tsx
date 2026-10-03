import { describe, expect, rs, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';
import { cloneElement, type ReactElement } from 'react';
import * as actual from 'recharts' with { rstest: 'importActual' };

import { ModelUsageTrend } from './model-usage-trend';

// Supply a hovered bucket without relying on browser layout or pointer coordinates.
// Keep the chart and its tooltip content real so assertions cover rendered rows.
rs.mock('recharts', () => {
  const tooltipProps = {
    active: true,
    label: '2026-10-03T12:00:00.000Z',
    payload: [
      { name: 'busy-model', dataKey: 'dimension:busy-model', value: 421, color: 'teal' },
      { name: 'idle-model', dataKey: 'dimension:idle-model', value: 0, color: 'teal' },
      { name: 'small-model', dataKey: 'dimension:small-model', value: 0.000000001, color: 'teal' },
      { name: 'Other', dataKey: 'other', value: 0, color: 'teal' },
    ],
  };
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 640, height: 288 } as Record<string, unknown>),
    Tooltip: ({ content }: { content: ReactElement | ((props: typeof tooltipProps) => ReactElement) }) => (
      <div data-testid="trend-tooltip">
        {typeof content === 'function' ? content(tooltipProps) : cloneElement(content, tooltipProps)}
      </div>
    ),
  };
});

describe('ModelUsageTrend', () => {
  test('omits zero-valued hover rows while retaining small nonzero values and the legend', () => {
    render(
      <ModelUsageTrend
        metric="requests"
        range="24h"
        onMetricChange={() => {}}
        trend={{
          series: [
            { key: 'dimension:busy-model', kind: 'dimension' },
            { key: 'dimension:idle-model', kind: 'dimension' },
            { key: 'dimension:small-model', kind: 'dimension' },
            { key: 'other', kind: 'other' },
          ],
          buckets: [
            {
              key: '2026-10-03T12:00:00.000Z',
              values: {
                'dimension:busy-model': 421n,
                'dimension:idle-model': 0n,
                'dimension:small-model': 1n,
                other: 0n,
              },
            },
          ],
        }}
      />,
    );

    const tooltip = within(screen.getByTestId('trend-tooltip'));
    expect(tooltip.getByText('busy-model')).toBeInTheDocument();
    expect(tooltip.getByText('421')).toBeInTheDocument();
    expect(tooltip.getByText('small-model')).toBeInTheDocument();
    expect(tooltip.queryByText('idle-model')).not.toBeInTheDocument();
    expect(tooltip.queryByText('Other')).not.toBeInTheDocument();
    expect(screen.getByText('idle-model')).toBeInTheDocument();
  });
});
