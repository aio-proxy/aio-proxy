import { TooltipProvider } from '@aio-proxy/ui/components/tooltip';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderModelCount } from './provider-model-count';

const renderCount = (models: readonly string[]) =>
  render(
    <TooltipProvider>
      <ProviderModelCount models={models} />
    </TooltipProvider>,
  );

test('hovering the count reveals every model', async () => {
  renderCount(['gpt-5', 'claude-opus-5']);

  expect(screen.queryByText('gpt-5')).not.toBeInTheDocument();

  const trigger = screen.getByTestId('provider-card-models-count');
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  fireEvent.mouseEnter(trigger);

  expect(await screen.findByText('gpt-5')).toBeInTheDocument();
  expect(screen.getByText('claude-opus-5')).toBeInTheDocument();
});

// The card's identity link stretches a positioned `::after` over the whole card; a statically
// positioned trigger paints under it and never sees a hover.
test('the count is stacked above the card-wide link overlay', () => {
  renderCount(['gpt-5']);

  const trigger = screen.getByTestId('provider-card-models-count');
  expect(trigger).toHaveClass('relative');
  expect(trigger).toHaveClass('z-10');
});

test('a Provider with no models offers nothing to hover', () => {
  renderCount([]);

  expect(screen.queryByTestId('provider-card-models-count')).not.toBeInTheDocument();
});
