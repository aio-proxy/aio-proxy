import type {
  DashboardOAuthCapability,
  DashboardOAuthProviderEdit,
  DashboardOAuthSession,
  OAuthProvider,
} from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OAuthProviderEditPage } from './oauth-provider-edit-page';

const capability: DashboardOAuthCapability = {
  plugin: '@example/oauth',
  capability: 'default',
  displayName: 'Example OAuth',
  description: 'Example account',
  defaults: {},
  form: [
    { type: 'text', key: 'tenant', label: 'Tenant' },
    { type: 'secret', key: 'token', label: 'Token', configured: false },
  ],
};

const oauth: DashboardOAuthProviderEdit = {
  accountLabel: 'Example',
  publicValues: { tenant: 'work' },
  form: capability.form,
  models: ['a'],
};

const provider = {
  kind: ProviderKind.OAuth,
  id: 'person',
  name: 'Personal',
  enabled: true,
  plugin: '@example/oauth',
  capability: 'default',
  metadata: { a: { name: 'A' } },
} as OAuthProvider;

const mocks = rs.hoisted(() => ({
  start: rs.fn(),
  create: rs.fn(),
  update: rs.fn(),
  delete: rs.fn(),
  navigate: rs.fn(),
  invalidate: rs.fn(),
  refetch: rs.fn(),
  session: undefined as DashboardOAuthSession | undefined,
  sessionError: false,
}));

rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly string[] }) => {
    let data: { capabilities: DashboardOAuthCapability[] } | { session: DashboardOAuthSession } | undefined;
    if (options.queryKey[0] === 'oauth-capabilities') data = { capabilities: [capability] };
    else if (mocks.session !== undefined) data = { session: mocks.session };
    return {
      data,
      isError: options.queryKey[0] === 'oauth-session' && mocks.sessionError,
      isLoading: false,
      refetch: mocks.refetch,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: () => ({ mutate: mocks.start, isPending: false }),
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => mocks.navigate,
}));

rs.mock('../hooks/use-provider-mutations', () => ({
  useProviderCreate: () => ({ mutate: mocks.create, isPending: false }),
  useProviderUpdate: () => ({
    mutate: (input: unknown, options?: { onSuccess?: () => void }) => {
      mocks.update(input, options);
      options?.onSuccess?.();
    },
    isPending: false,
  }),
  useProviderDelete: () => ({ mutate: mocks.delete, isPending: false }),
}));

afterEach(() => {
  rs.restoreAllMocks();
  mocks.start.mockReset();
  mocks.create.mockReset();
  mocks.update.mockReset();
  mocks.delete.mockReset();
  mocks.navigate.mockReset();
  mocks.invalidate.mockReset();
  mocks.refetch.mockReset();
  mocks.session = undefined;
  mocks.sessionError = false;
});

test('OAuth edit page common-only save resends persisted model metadata', async () => {
  render(<OAuthProviderEditPage provider={provider} oauth={oauth} sessionId={undefined} onSessionIdChange={rs.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: /Save|保存/u }));

  await waitFor(() => expect(mocks.update).toHaveBeenCalled());
  expect(mocks.create).not.toHaveBeenCalled();
  const input = mocks.update.mock.calls[0]?.[0] as { body: { metadata?: unknown } };
  expect(input.body.metadata).toEqual({ a: { name: 'A' } });
});
