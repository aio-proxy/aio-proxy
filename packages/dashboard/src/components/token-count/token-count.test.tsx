import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TokenCount } from './token-count';

test('renders muted N/A when the token count is unavailable', () => {
  render(<TokenCount value={undefined} />);

  expect(screen.getByText('N/A')).toHaveClass('tabular-nums', 'text-muted-foreground');
});
