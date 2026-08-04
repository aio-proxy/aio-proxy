import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TraceLoadOlderRow } from './trace-load-older-row';

test('hides at the terminal page and blocks transitions from skipping pages', () => {
  const onLoadOlder = rs.fn();
  const view = render(
    <table>
      <tbody>
        <TraceLoadOlderRow
          columnCount={10}
          page={1}
          pageCount={3}
          isFetching
          isPlaceholderData={false}
          onLoadOlder={onLoadOlder}
        />
      </tbody>
    </table>,
  );

  const button = screen.getByRole('button', { name: /older|更早/u });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onLoadOlder).not.toHaveBeenCalled();

  view.rerender(
    <table>
      <tbody>
        <TraceLoadOlderRow
          columnCount={10}
          page={3}
          pageCount={3}
          isFetching={false}
          isPlaceholderData={false}
          onLoadOlder={onLoadOlder}
        />
      </tbody>
    </table>,
  );
  expect(screen.queryByRole('button', { name: /older|更早/u })).toBeNull();
});
