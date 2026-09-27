import { m } from '@aio-proxy/i18n';
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

/** Segment widths in document order, for the configured row (0) or an actual row. */
const widthsOf = (container: HTMLElement, row: 'configured' | number): readonly string[] => {
  const node =
    row === 'configured'
      ? container.querySelector('.flex.h-3')
      : container.querySelectorAll('[data-testid="routing-share-actual"]')[row];
  return [...(node?.children ?? [])].map((child) => (child as HTMLElement).style.width);
};

test('draws a configured segment per provider at its configured width', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  expect(screen.getByLabelText(/primary/u)).toBeInTheDocument();
  expect(screen.getByLabelText(/fallback/u)).toBeInTheDocument();
  expect(widthsOf(container, 'configured')).toStrictEqual(['50%', '50%']);
});

test('omits the actual overlay entirely when traffic is unknown', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  // Absent is not zero: a 0-width overlay would read as "actual share is zero".
  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(0);
});

test('draws the actual overlay at the measured widths once traffic is known', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={actual} />);

  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(1);
  expect(widthsOf(container, 0)).toStrictEqual(['93%', '7%']);
});

test('keeps a silent provider in position instead of shifting the tier left', () => {
  // The actual row once mapped only the providers that had traffic, so a provider serving nothing
  // dropped out and its neighbour's segment slid under its configured share — the operator read
  // the surviving provider as over-serving when the split was the exact opposite.
  const { container } = render(
    <RoutingShareBar
      tiers={tiers}
      actual={[{ providerId: 'fallback', actualShare: 1, successRate: 1, p95LatencyMs: 10, finalCount: 7n }]}
    />,
  );

  expect(widthsOf(container, 0)).toStrictEqual(['0%', '100%']);
  expect(screen.getByLabelText(`primary, ${m['dashboard.routing.share.actual']()}, 0%`)).toBeInTheDocument();
});

test('gives a provider the same colour in both rows of its tier', () => {
  // Widths alone cannot be matched up once a segment collapses to nothing, so colour is what makes
  // the configured and actual rows comparable.
  const { container } = render(<RoutingShareBar tiers={tiers} actual={actual} />);

  const colourOf = (node: Element) => (node as HTMLElement).style.backgroundColor;
  const configured = [...(container.querySelector('.flex.h-3')?.children ?? [])].map(colourOf);
  const measured = [...(container.querySelectorAll('[data-testid="routing-share-actual"]')[0]?.children ?? [])].map(
    colourOf,
  );

  expect(configured).toStrictEqual(measured);
  expect(new Set(configured).size).toBe(2);
});

test('names the priority tier each row belongs to', () => {
  render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  expect(screen.getByText(m['dashboard.routing.share.tier']({ value: 30 }))).toBeInTheDocument();
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
  // Each tier's share is taken over its own members, so both rows are full width.
  expect(widthsOf(container, 0)).toStrictEqual(['100%']);
  expect(widthsOf(container, 1)).toStrictEqual(['100%']);
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
