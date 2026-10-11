import { afterEach, expect, rs, test } from '@rstest/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';

import { DeleteProviderDialog, type DeleteProviderDialogRef } from './delete-provider-dialog';

const mocks = rs.hoisted(() => ({ mutate: rs.fn() }));

rs.mock('../../hooks/use-provider-mutations', () => ({
  useProviderDelete: () => ({ mutate: mocks.mutate, isPending: false }),
}));

afterEach(() => {
  mocks.mutate.mockReset();
});

test('notifies the edit page after a confirmed Provider deletion', () => {
  const onDeleted = rs.fn();
  const ref = createRef<DeleteProviderDialogRef>();
  mocks.mutate.mockImplementation((_id, options) => options.onSuccess());

  render(<DeleteProviderDialog ref={ref} onDeleted={onDeleted} />);
  act(() => ref.current?.open({ id: 'carpool' }));
  fireEvent.click(screen.getByTestId('delete-confirm'));

  expect(mocks.mutate).toHaveBeenCalledWith('carpool', expect.any(Object));
  expect(onDeleted).toHaveBeenCalledTimes(1);
});

test('deleting a linked Provider explains that the local tool stays signed in', () => {
  const ref = createRef<DeleteProviderDialogRef>();
  render(<DeleteProviderDialog ref={ref} />);
  act(() => ref.current?.open({ id: 'linked', localSignInSource: { default: 'Vendor CLI', en: 'Codex' } }));

  expect(screen.getByRole('alertdialog')).toHaveTextContent(
    'This Provider uses the Codex sign-in on this machine. Removing it will not sign Codex out.',
  );
  fireEvent.click(screen.getByTestId('delete-confirm'));
  expect(mocks.mutate).toHaveBeenCalledWith('linked', expect.any(Object));
});

test('deleting an unlinked Provider has no local sign-in note', () => {
  const ref = createRef<DeleteProviderDialogRef>();
  render(<DeleteProviderDialog ref={ref} />);
  act(() => ref.current?.open({ id: 'unlinked' }));
  expect(screen.getByRole('alertdialog')).not.toHaveTextContent('on this machine');
});
