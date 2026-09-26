import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { RoutingShareBar } from './routing-share-bar';

const tiers = [
  {
    priority: 30,
    providers: [
      { providerId: 'primary', weight: 1, share: 0.5 },
      { providerId: 'fallback', weight: 1, share: 0.5 },
    ],
  },
] as const;

const actual = [
  { providerId: 'primary', actualShare: 0.93, successRate: 0.5, p95LatencyMs: 60, finalCount: 93n },
  { providerId: 'fallback', actualShare: 0.07, successRate: 1, p95LatencyMs: 10, finalCount: 7n },
] as const;

test('draws a configured segment per provider with its share in the label', () => {
  render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  expect(screen.getByLabelText(/primary/u)).toBeInTheDocument();
  expect(screen.getByLabelText(/fallback/u)).toBeInTheDocument();
});

test('omits the actual overlay entirely when traffic is unknown', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  // Absent is not zero: a 0-width overlay would read as "actual share is zero".
  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(0);
});

test('draws the actual overlay once traffic is known', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={actual} />);

  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(1);
});

test('draws each priority tier actual shares in its own row', () => {
  const { container } = render(
    <RoutingShareBar
      tiers={[
        { priority: 30, providers: [{ providerId: 'primary', weight: 1, share: 1 }] },
        { priority: 0, providers: [{ providerId: 'fallback', weight: 1, share: 1 }] },
      ]}
      actual={[
        { providerId: 'primary', actualShare: 1, successRate: 1, p95LatencyMs: 10, finalCount: 1n },
        { providerId: 'fallback', actualShare: 1, successRate: 1, p95LatencyMs: 20, finalCount: 1n },
      ]}
    />,
  );

  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(2);
});

test('makes configured and actual share segments keyboard focusable images', () => {
  render(<RoutingShareBar tiers={tiers} actual={actual} />);

  for (const segment of screen.getAllByRole('img')) {
    expect(segment).toHaveAttribute('tabindex', '0');
  }
});

test('renders a disabled badge when no tier has an eligible provider', () => {
  render(<RoutingShareBar tiers={[]} actual={undefined} />);

  expect(screen.getByText(/Disabled|禁用/u)).toBeInTheDocument();
});
