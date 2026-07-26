import { fireEvent, screen } from '@testing-library/react';

export const value = {
  from: new Date(2026, 6, 20, 0, 0),
  to: new Date(2026, 6, 20, 23, 59, 59, 999),
};

export const openPicker = () => fireEvent.click(screen.getByRole('button', { name: /Time range|时间范围/u }));
