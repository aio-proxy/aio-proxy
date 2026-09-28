import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { RevokeInstallationButton } from './revoke-installation-button';

const mocks = rs.hoisted(() => ({ toast: rs.fn() }));

rs.mock('@aio-proxy/ui/components/toast', () => ({ toast: { add: mocks.toast } }));
rs.mock('../../hooks/use-revoke-installation', () => ({
  useRevokeInstallation: () => ({
    isPending: false,
    mutate: (_id: string, options: { onError: (error: Error) => void }) => options.onError(new Error('offline')),
  }),
}));

test('a revoke that fails says the authorization was not revoked', () => {
  render(<RevokeInstallationButton installationId="0f4dcb50-d68c-4b99-8af1-da32480ddd09" disabled={false} />);
  fireEvent.click(screen.getByRole('button'));
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error', title: expect.stringMatching(/not revoked|未能撤销/u) }),
  );
});
