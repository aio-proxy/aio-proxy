import { m } from '@aio-proxy/i18n';
import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import type { RoutingRiskCounts } from '../../lib/routing-risk';
import type { RoutingRiskFilter } from '../../lib/routing-search';
import { RoutingHealthStrip } from './routing-health-strip';

const counts = { 'no-eligible': 3, 'single-point': 41, deviating: 7 } as const;

const renderStrip = (options: {
  readonly counts?: RoutingRiskCounts;
  readonly active?: RoutingRiskFilter;
  readonly trafficUnavailable?: boolean;
  readonly onToggle?: (risk: RoutingRiskFilter) => void;
}) =>
  render(
    <RoutingHealthStrip
      total={217}
      counts={options.counts ?? counts}
      active={options.active}
      trafficUnavailable={options.trafficUnavailable ?? false}
      onToggle={options.onToggle ?? (() => {})}
    />,
  );

test('shows every count and marks the active filter pressed', () => {
  renderStrip({ active: 'no-eligible' });

  expect(screen.getByText('217')).toBeInTheDocument();
  expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('3');
});

test('renders the four health metrics as standalone dashboard cards', () => {
  renderStrip({});

  const cards = document.querySelectorAll('[data-slot="card"]');
  expect(cards).toHaveLength(4);
  expect([...cards].every((card) => card.getAttribute('data-size') === 'sm')).toBe(true);
});

test('renders risk cards as the interactive Card element itself', () => {
  renderStrip({});

  const riskCard = screen.getByText('3').closest('[data-slot="card"]');
  expect(riskCard?.tagName).toBe('BUTTON');
  expect(riskCard?.querySelector('button')).toBeNull();
});

test('uses one dashboard title style for every health card', () => {
  renderStrip({});

  const titles = [...document.querySelectorAll('[data-slot="card-title"]')];
  expect(titles).toHaveLength(4);
  expect(new Set(titles.map((title) => title.className))).toHaveLength(1);
});

test('uses the whole risk card as the selected surface', () => {
  renderStrip({ active: 'no-eligible' });

  const selectedCard = screen.getByText('3').closest('[data-slot="card"]');
  expect(selectedCard).toHaveClass('bg-muted', 'ring-2', 'ring-primary');
});

test('toggles the risk it was clicked with', () => {
  const onToggle = rs.fn();
  renderStrip({ onToggle });

  screen.getByText('41').closest('button')?.click();

  expect(onToggle).toHaveBeenCalledWith('single-point');
});

test('never renders zero for a deviation count that is still being measured', () => {
  // A traffic query that has not landed yet is unknown, not "no deviation".
  renderStrip({ counts: { ...counts, deviating: undefined } });

  expect(screen.queryByText('0')).not.toBeInTheDocument();
  expect(screen.getByText(m['dashboard.routing.health.deviating_pending']())).toBeInTheDocument();
});

test('does not let a deviation tile that is still measuring be filtered by', () => {
  const onToggle = rs.fn();
  renderStrip({ counts: { ...counts, deviating: undefined }, onToggle });

  screen.getByText(m['dashboard.routing.health.deviating_pending']()).closest('button')?.click();

  expect(onToggle).not.toHaveBeenCalled();
});

test('drops the deviation tile entirely when traffic cannot be measured at all', () => {
  // A failed traffic query is not a pending one: leaving the tile up as "measuring" would promise
  // a number that never arrives, so the whole tile goes rather than showing a state it cannot leave.
  renderStrip({ counts: { ...counts, deviating: undefined }, trafficUnavailable: true });

  expect(screen.queryByText(m['dashboard.routing.health.deviating_pending']())).not.toBeInTheDocument();
  expect(screen.queryByText(m['dashboard.routing.health.deviating']())).not.toBeInTheDocument();
  // The configuration-derived risks do not need traffic and must survive the failure.
  expect(screen.getAllByRole('button')).toHaveLength(2);
});

test('keeps a deviation count that was already measured when a later refetch fails', () => {
  // React Query keeps the last successful payload, so a background refetch failure still has a
  // real measurement to show. Hiding it there would discard a usable number.
  renderStrip({ trafficUnavailable: false });

  expect(screen.getByText('7')).toBeInTheDocument();
});

test('leaves the total tile unclickable', () => {
  renderStrip({});

  // Three clickable risks, and the total is not one of them.
  expect(screen.getAllByRole('button')).toHaveLength(3);
});
