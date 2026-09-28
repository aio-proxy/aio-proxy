import { m } from '@aio-proxy/i18n';
import { TooltipProvider } from '@aio-proxy/ui/components/tooltip';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { RoutingTierLabel } from './routing-tier-label';

test('renders the tier number and reveals its priority on hover', async () => {
  render(
    <TooltipProvider>
      <RoutingTierLabel tier={2} priority={10} />
    </TooltipProvider>,
  );

  const label = screen.getByText(m['dashboard.routing.tier_label.tier']({ value: 2 }));
  expect(label).toBeInTheDocument();

  fireEvent.pointerEnter(label, { pointerType: 'mouse' });
  fireEvent.mouseEnter(label);

  expect(await screen.findByText(m['dashboard.routing.tier_label.priority']({ value: 10 }))).toBeInTheDocument();
});
