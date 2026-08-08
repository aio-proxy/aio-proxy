import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { Pagination } from '.';

rs.mock('@aio-proxy/i18n', () => ({
  m: {
    'dashboard.pagination.page_size': () => 'Localized rows per page',
    'dashboard.pagination.previous': () => 'Localized previous',
    'dashboard.pagination.next': () => 'Localized next',
  },
}));

describe('pagination controls', () => {
  test('localizes controls and reports page size changes without assuming a page model', async () => {
    const onPrevious = rs.fn();
    const onNext = rs.fn();
    const onShowSizeChange = rs.fn();

    render(
      <Pagination
        pageSize={25}
        pageSizeOptions={[10, 25, 50]}
        canPrevious={false}
        canNext
        onShowSizeChange={onShowSizeChange}
        onPrevious={onPrevious}
        onNext={onNext}
      />,
    );

    const previous = screen.getByRole('button', { name: 'Localized previous' });
    const next = screen.getByRole('button', { name: 'Localized next' });
    const pageSize = screen.getByRole('combobox', { name: 'Localized rows per page' });

    expect(pageSize).toHaveTextContent('25');
    expect(previous).toHaveAttribute('aria-disabled', 'true');
    expect(previous).toHaveAttribute('tabindex', '-1');
    expect(next).toBeEnabled();
    expect(previous).toHaveTextContent('Localized previous');
    expect(next).toHaveTextContent('Localized next');

    fireEvent.click(pageSize);
    const option = await screen.findByRole('option', { name: '50' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);

    fireEvent.click(previous);
    fireEvent.click(next);

    expect(onShowSizeChange).toHaveBeenCalledWith(50);
    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledOnce();
  });
});
