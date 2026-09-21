import { ProviderProtocol } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { PROTOCOL_ORDER, ProtocolLabel } from '@/components/protocol-label';

test('shows the protocol icon only when enabled', () => {
  const { container, rerender } = render(<ProtocolLabel protocol={ProviderProtocol.OpenAIResponse} />);

  expect(screen.getByText('OpenAI Response')).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();

  rerender(<ProtocolLabel protocol={ProviderProtocol.OpenAIResponse} showIcon />);
  expect(container.querySelector('img')).toHaveAttribute('alt', '');
});

test('renders a real System One icon rather than a missing remote asset', () => {
  const { container } = render(<ProtocolLabel protocol={ProviderProtocol.TypeSafeSystemOne} showIcon />);

  expect(screen.getByText('TypeSafe System One')).toBeInTheDocument();
  // Every other protocol renders an <img> from the lobehub CDN. TypeSafe has no
  // published asset there, so an <img> here is the empty box the inline SVG
  // replaced - which no visual review of a card catches, because the layout is
  // identical either way.
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
});

test('the protocol picker offers TypeSafe System One', () => {
  // A protocol the config schema accepts but the picker never lists cannot be
  // configured from the dashboard at all, and its traffic cannot be filtered for
  // on the traces page.
  expect(PROTOCOL_ORDER).toContain(ProviderProtocol.TypeSafeSystemOne);
});
