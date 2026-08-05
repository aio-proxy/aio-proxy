import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { PaginationControls } from './pagination-controls';

describe('pagination controls', () => {
  test('exposes icon-only previous and next actions without assuming a page model', () => {
    const onPrevious = rs.fn();
    const onNext = rs.fn();

    render(<PaginationControls canPrevious={false} canNext onPrevious={onPrevious} onNext={onNext} />);

    const previous = screen.getByRole('button', { name: /previous|上一页|前へ|이전/iu });
    const next = screen.getByRole('button', { name: /next|下一页|次へ|다음/iu });

    expect(previous).toHaveAttribute('aria-disabled', 'true');
    expect(previous).toHaveAttribute('tabindex', '-1');
    expect(next).not.toHaveAttribute('aria-disabled');
    expect(previous).toHaveClass('[&_span]:hidden');
    expect(next).toHaveClass('[&_span]:hidden');

    fireEvent.click(previous);
    fireEvent.click(next);

    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledOnce();
  });
});
