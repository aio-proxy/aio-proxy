import { Switch } from '@aio-proxy/ui/components/switch';
import { expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

// happy-dom does not implement the reflected `switch` IDL property, so this file exercises the
// Base UI fallback with no setup. The native branch needs the opposite global state and lives in
// switch-native.test.tsx — see the comment there for why it is a separate file.
test('Switch falls back to the Base UI switch and still reports toggles without native support', () => {
  expect('switch' in HTMLInputElement.prototype).toBe(false);

  const changes: boolean[] = [];
  render(<Switch aria-label="Fallback" checked={false} onCheckedChange={(next) => changes.push(next)} />);

  fireEvent.click(screen.getByRole('switch', { name: 'Fallback' }));
  expect(changes).toEqual([true]);
});
