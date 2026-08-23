import type { DashboardOAuthCapability, DashboardOAuthSession } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { OAuthProviderCreatePage } from './oauth-provider-create-page';

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

const mocks = rs.hoisted(() => ({
  start: rs.fn(),
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

afterEach(() => {
  rs.restoreAllMocks();
  mocks.start.mockReset();
  mocks.session = undefined;
  mocks.sessionError = false;
});

const startCreateAuthorization = async () => {
  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));
  fireEvent.click(screen.getByRole('button', { name: /Continue authorization|继续授权/u }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalled());
};

test('OAuth create page selects a capability and renders its account fields before authorization', async () => {
  render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  expect(
    screen.getByRole('navigation', { name: /^Breadcrumbs$|^面包屑$|^パンくずリスト$|^브레드크럼$/u }),
  ).toBeTruthy();
  expect(screen.queryByLabelText(/^Back$|^返回$|^戻る$|^뒤로$/u)).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();

  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));

  expect(screen.getByLabelText('Tenant')).toBeTruthy();
  expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
  expect(screen.getByRole('combobox', { name: /Proxy mode|代理模式/u })).toHaveTextContent(
    /Inherit global proxy|继承全局代理/u,
  );
  expect(screen.getByRole('button', { name: /Continue authorization|继续授权/u })).toBeTruthy();
});

test('OAuth create starts at priority 0 and weight 1, renders both controls, and submits both', async () => {
  render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));

  const priority = within(screen.getByTestId('provider-form-field-priority')).getByRole('spinbutton');
  const weight = within(screen.getByTestId('provider-form-field-weight')).getByRole('spinbutton');
  expect(priority).toHaveValue(0);
  expect(weight).toHaveValue(1);
  expect(priority).toHaveAttribute('step', '1');
  expect(weight).toHaveAttribute('step', 'any');

  fireEvent.change(priority, { target: { value: '4' } });
  fireEvent.change(weight, { target: { value: '1.6' } });
  expect(screen.getByText(/normalize 1\.6 to 2|将 1\.6 规范为 2/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Continue authorization|继续授权/u }));

  await waitFor(() =>
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPatch: expect.objectContaining({ enabled: true, priority: 4, weight: 2 }),
      }),
      expect.objectContaining({ onError: expect.any(Function) }),
    ),
  );
});

test('OAuth create page submits a typed provider proxy patch without using the stepper', async () => {
  render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));

  const proxy = screen.getByRole('combobox', { name: /Proxy mode|代理模式/u });
  fireEvent.click(proxy);
  const disabled = await screen.findByRole('option', { name: /Disable proxy|禁用代理/u });
  fireEvent.pointerDown(disabled, { pointerType: 'mouse' });
  fireEvent.click(disabled);
  await waitFor(() => expect(proxy).toHaveTextContent(/Disable proxy|禁用代理/u));
  fireEvent.click(screen.getByRole('button', { name: /Continue authorization|继续授权/u }));

  expect(screen.queryByRole('tablist')).toBeNull();
  await waitFor(() =>
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ providerPatch: expect.objectContaining({ enabled: true, proxy: false }) }),
      expect.objectContaining({ onError: expect.any(Function) }),
    ),
  );
});

test('OAuth create page navigates the pre-opened popup when authorization is ready', async () => {
  const close = rs.fn();
  const popup = { location: { href: '' }, close } as unknown as Window;
  const open = rs.spyOn(window, 'open').mockReturnValue(popup);
  const view = render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));
  fireEvent.click(screen.getByRole('button', { name: /Continue authorization|继续授权/u }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));

  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'authorize_url',
    url: 'https://example.com/authorize',
  };
  view.rerender(
    <OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />,
  );

  expect(popup.location.href).toBe('https://example.com/authorize');
  expect(open).toHaveBeenCalledTimes(1);

  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'loopback',
    authorizationUrl: 'https://example.com/loopback',
    allowManualCallback: false,
  };
  view.rerender(
    <OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />,
  );

  expect(popup.location.href).toBe('https://example.com/authorize');

  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'failed',
    code: 'FAILED_AFTER_NAVIGATION',
  };
  view.rerender(
    <OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />,
  );
  view.unmount();

  expect(close).not.toHaveBeenCalled();
});

test.each(['start failure', 'failed', 'cancelled', 'unavailable', 'unmount'] as const)(
  'OAuth create page closes its unclaimed popup on %s',
  async (scenario) => {
    const close = rs.fn();
    rs.spyOn(window, 'open').mockReturnValue({ location: { href: '' }, close } as unknown as Window);
    const view = render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);
    await startCreateAuthorization();

    if (scenario === 'start failure') {
      const onError = (mocks.start.mock.calls.at(-1)?.[1] as { onError?: () => void } | undefined)?.onError;
      expect(typeof onError).toBe('function');
      onError?.();
    } else if (scenario === 'unmount') {
      view.unmount();
    } else {
      mocks.sessionError = scenario === 'unavailable';
      mocks.session =
        scenario === 'failed'
          ? { id: 'session', status: 'failed', code: 'START_FAILED' }
          : scenario === 'cancelled'
            ? { id: 'session', status: 'cancelled' }
            : undefined;
      view.rerender(<OAuthProviderCreatePage sessionId="session" onSessionIdChange={rs.fn()} />);
    }

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  },
);

test('OAuth create page hides the setup form while an existing session loads', () => {
  render(<OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />);

  expect(screen.queryByRole('button', { name: /Continue authorization|继续授权/u })).toBeNull();
});

test('OAuth create page offers a restart when an existing session cannot be loaded', () => {
  mocks.sessionError = true;
  const changeSession = rs.fn();
  render(
    <OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={changeSession} />,
  );

  expect(screen.getByText(/session is unavailable|授权会话不可用/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Start over|重新开始/u }));
  expect(changeSession).toHaveBeenCalledWith(undefined);
});

test('OAuth create page refreshes providers after authorization succeeds', () => {
  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'succeeded',
    providerId: 'new-provider',
  };

  render(<OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />);

  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['providers'] });
});
