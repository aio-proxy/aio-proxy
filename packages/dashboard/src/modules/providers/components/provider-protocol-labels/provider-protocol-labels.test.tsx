import { ProviderProtocol } from '@aio-proxy/types';
import { TooltipProvider } from '@aio-proxy/ui/components/tooltip';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderProtocolLabels } from './provider-protocol-labels';

const renderLabels = (protocols: readonly ProviderProtocol[]) =>
  render(
    <TooltipProvider>
      <ProviderProtocolLabels protocols={protocols} />
    </TooltipProvider>,
  );

test('a single protocol is named inline with no tooltip to discover', () => {
  renderLabels([ProviderProtocol.Anthropic]);

  expect(screen.getByText('Anthropic')).toBeInTheDocument();
  expect(screen.queryByTestId('provider-protocols-multi')).not.toBeInTheDocument();
});

test('hovering the collapsed label reveals every protocol', async () => {
  renderLabels([ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic]);

  const trigger = screen.getByTestId('provider-protocols-multi');
  expect(screen.queryByText('OpenAI Compatible')).not.toBeInTheDocument();

  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  fireEvent.mouseEnter(trigger);

  expect(await screen.findByText('OpenAI Compatible')).toBeInTheDocument();
  expect(screen.getByText('Anthropic')).toBeInTheDocument();
});

// The card's identity link stretches a positioned `::after` over the whole card. A statically
// positioned trigger paints under it and never sees a hover, which is exactly the bug this guards.
test('the collapsed label is stacked above the card-wide link overlay', () => {
  renderLabels([ProviderProtocol.OpenAICompatible, ProviderProtocol.Anthropic]);

  const trigger = screen.getByTestId('provider-protocols-multi');
  expect(trigger).toHaveClass('relative');
  expect(trigger).toHaveClass('z-10');
});
