import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TokenActivityHeatmap } from './token-activity-heatmap';

const activity = {
  from: '2025-08-10',
  to: '2026-08-05',
  items: [
    { date: '2025-08-10', totalTokens: 500n, models: [] },
    {
      date: '2025-08-11',
      totalTokens: 2_000n,
      models: [
        { modelId: 'gpt-5', totalTokens: 1_500n },
        { modelId: 'claude-opus-4', totalTokens: 500n },
      ],
    },
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

    fireEvent.mouseEnter(screen.getByLabelText(/2K Token/u));

    expect(screen.getByText('2K Token')).toBeInTheDocument();
    expect(screen.getByText('gpt-5')).toBeInTheDocument();
    expect(screen.getByText('1.5K')).toBeInTheDocument();
  });

  test('shows a daily total without model breakdown when no models are present', () => {
    render(<TokenActivityHeatmap activity={activity} />);

    fireEvent.mouseEnter(screen.getByLabelText(/500 Token/u));

    expect(screen.getByText('500 Token')).toBeInTheDocument();
    expect(screen.queryByText('Model breakdown')).not.toBeInTheDocument();
  });
});
