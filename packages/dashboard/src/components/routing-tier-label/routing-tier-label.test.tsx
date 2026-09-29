import { m } from '@aio-proxy/i18n';
import { TooltipProvider } from '@aio-proxy/ui/components/tooltip';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { RoutingTierLabel } from './routing-tier-label';

test('marks the tier as T-number, named in full for assistive tech, with its priority on hover', async () => {
  render(
    <TooltipProvider>
      <RoutingTierLabel tier={2} priority={10} />
    </TooltipProvider>,
  );

  const label = screen.getByText(m['dashboard.routing.tier_label.short']({ value: 2 }));
  expect(label).toHaveAccessibleName(m['dashboard.routing.tier_label.tier']({ value: 2 }));

  fireEvent.pointerEnter(label, { pointerType: 'mouse' });
  fireEvent.mouseEnter(label);

  expect(
    await screen.findByText(new RegExp(m['dashboard.routing.tier_label.priority']({ value: 10 }), 'u')),
  ).toBeDefined();
  expect(screen.getByText(m['dashboard.routing.tier_label.fallback']())).toBeInTheDocument();
});
