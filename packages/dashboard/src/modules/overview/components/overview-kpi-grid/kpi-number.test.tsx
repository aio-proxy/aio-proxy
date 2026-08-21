import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { KpiNumber } from './kpi-number';

// NumberFlow renders each digit into shadow DOM, so the formatted value must stay
// readable to assistive tech and to tests.
test('exposes the formatted value as an accessible label', () => {
  render(<KpiNumber value={18_492} format={{}} locales="en" />);

  expect(screen.getByRole('img', { name: '18,492' })).toBeInTheDocument();
});

test('formats a decimal string value without floating point drift', () => {
  render(
    <KpiNumber
      value="1234.56789"
      format={{ currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 2, style: 'currency' }}
      locales="en"
    />,
  );

  expect(screen.getByRole('img', { name: '$1,234.57' })).toBeInTheDocument();
});

test('visible text keeps a string above Number.MAX_SAFE_INTEGER instead of Number() rounding it to 9007199254740992', () => {
  render(<KpiNumber value="9007199254740993" format={{}} locales="en" />);

  expect(screen.getByRole('img', { name: '9,007,199,254,740,993' })).toHaveTextContent('9,007,199,254,740,993');
});
