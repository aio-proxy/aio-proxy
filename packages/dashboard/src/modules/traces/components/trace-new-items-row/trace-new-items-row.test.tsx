import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TraceNewItemsRow } from './trace-new-items-row';

test('renders one full-row action without a nested underlined sub-action', () => {
  const onAccept = rs.fn();
  const view = render(
    <table>
      <tbody>
        <TraceNewItemsRow columnCount={10} count={3} onAccept={onAccept} />
      </tbody>
    </table>,
  );

  const button = screen.getByRole('button', { name: /new traces available:\s*3|新.*3|3.*新/iu });
  expect(button.parentElement?.tagName).toBe('TD');
  expect(button.parentElement?.parentElement?.tagName).toBe('TR');
  expect(button.parentElement).toHaveAttribute('colspan', '10');
  expect(button).toHaveClass('w-full');
  expect(view.container.querySelector('u, a')).toBeNull();

  fireEvent.click(button);
  expect(onAccept).toHaveBeenCalledTimes(1);
});
