import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WeightedTierBoard, type WeightedTierBoardItem } from './weighted-tier-board';

interface FixtureItem {
  readonly name: string;
}

const item = (id: string, name: string): WeightedTierBoardItem<FixtureItem> => ({
  id,
  value: { name },
  draggable: true,
  dragLabel: `Move ${name}`,
  shareLabel: '50%',
  control: {
    ariaLabel: `${name} share`,
    min: 1,
    max: 100,
    value: 50,
    onChange: rs.fn(),
  },
});

const tiers = [
  { id: 'high', items: [item('a', 'Alpha')] },
  { id: 'low', items: [item('b', 'Beta')] },
];

const labels = {
  tier: (index: number) => `Tier ${index + 1}`,
  tierCount: (count: number) => `${count} items`,
  dragTier: (index: number) => `Move tier ${index + 1}`,
  newTier: 'New tier',
};

afterEach(() => {
  Reflect.deleteProperty(document, 'getAnimations');
});

test('a whole-tier keyboard drag collapses every tier and cancellation expands them', async () => {
  Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [] });
  const onLayoutChange = rs.fn();
  render(
    <WeightedTierBoard
      tiers={tiers}
      writable
      labels={labels}
      renderItem={({ name }) => <span>{name}</span>}
      onLayoutChange={onLayoutChange}
    />,
  );

  expect(screen.getByRole('button', { name: 'Move Alpha' })).toBeInTheDocument();
  const handle = screen.getByRole('button', { name: 'Move tier 1' });
  fireEvent.keyDown(handle, { key: ' ', code: 'Space' });

  await waitFor(() => {
    for (const body of screen.getAllByTestId('weighted-tier-body')) {
      expect(body).toHaveAttribute('data-collapsed', 'true');
    }
  });

  fireEvent.keyDown(handle, { key: 'Escape', code: 'Escape' });
  await waitFor(() => {
    for (const body of screen.getAllByTestId('weighted-tier-body')) {
      expect(body).not.toHaveAttribute('data-collapsed');
    }
  });
  expect(onLayoutChange).not.toHaveBeenCalled();
});

test('read-only boards omit every drag handle, insertion slot, and share slider', () => {
  render(
    <WeightedTierBoard
      tiers={tiers}
      writable={false}
      labels={labels}
      renderItem={({ name }) => <span>{name}</span>}
      onLayoutChange={rs.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: /Move/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('New tier')).not.toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(screen.getByText('Alpha')).toBeInTheDocument();
});
