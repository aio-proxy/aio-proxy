import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TokenActivityHeatmap } from './token-activity-heatmap';

const activity = {
  from: '2025-08-10',
  to: '2026-08-05',
  items: [
    { date: '2025-08-10', totalTokens: 500n, models: [] },
    { date: '2025-08-11', totalTokens: 2_000n, models: [{ modelId: 'gpt-5', totalTokens: 2_000n }] },
  ],
};

describe('TokenActivityHeatmap', () => {
  test('renders its Less and More legend without year controls', () => {
    render(<TokenActivityHeatmap activity={activity} />);

    expect(screen.getByText('Less')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('shows compact tokens and model breakdown when hovering an active day', () => {
    render(<TokenActivityHeatmap activity={activity} />);

    fireEvent.mouseEnter(screen.getByRole('gridcell', { name: /2K TOKEN/u }));

    expect(screen.getByText('2K TOKEN')).toBeInTheDocument();
    expect(screen.getByText('gpt-5')).toBeInTheDocument();
  });

  test('shows a daily total without model breakdown when no models are present', () => {
    render(<TokenActivityHeatmap activity={activity} />);

    fireEvent.mouseEnter(screen.getByRole('gridcell', { name: /500 TOKEN/u }));

    expect(screen.getByText('500 TOKEN')).toBeInTheDocument();
    expect(screen.queryByText('Model breakdown')).not.toBeInTheDocument();
  });
});
