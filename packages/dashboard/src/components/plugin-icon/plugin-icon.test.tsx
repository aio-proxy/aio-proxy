import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { PluginIcon } from './plugin-icon';

test('renders Lobe keys and removes failed URL icons', () => {
  const { rerender } = render(<PluginIcon icon="openai" size={16} />);

  expect(screen.getByRole('img', { hidden: true })).toHaveAttribute('src', expect.stringContaining('openai.svg'));

  rerender(<PluginIcon icon="https://example.com/openai.svg" size={16} />);
  const image = screen.getByRole('img', { hidden: true });
  expect(image).toHaveAttribute('src', 'https://example.com/openai.svg');
  fireEvent.error(image);
  expect(screen.queryByRole('img', { hidden: true })).toBeNull();
});
