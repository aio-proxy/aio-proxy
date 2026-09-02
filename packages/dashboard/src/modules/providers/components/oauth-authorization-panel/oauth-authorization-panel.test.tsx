import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OAuthAuthorizationPanel } from './oauth-authorization-panel';

test('shows specific fingerprint mismatch guidance', () => {
  render(
    <OAuthAuthorizationPanel
      session={{
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'failed',
        code: 'PROVIDER_FINGERPRINT_MISMATCH',
      }}
      onSubmitCallback={rs.fn()}
      onCancel={rs.fn()}
      isPending={false}
    />,
  );

  expect(screen.getByText(/different account|其他账户/u)).toBeTruthy();
});

test('clears a manually submitted callback URL', async () => {
  const submit = rs.fn();
  render(
    <OAuthAuthorizationPanel
      session={{
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'loopback',
        authorizationUrl: 'https://example.com/authorize',
        allowManualCallback: true,
      }}
      onSubmitCallback={submit}
      onCancel={rs.fn()}
      isPending={false}
    />,
  );

  const input = screen.getByLabelText(/Complete callback URL|完整回调 URL/u);
  fireEvent.change(input, { target: { value: 'http://127.0.0.1/callback?code=secret' } });
  fireEvent.click(screen.getByRole('button', { name: /Submit callback|提交回调/u }));

  await waitFor(() => {
    expect(submit).toHaveBeenCalledWith('http://127.0.0.1/callback?code=secret');
    expect(input).toHaveValue('');
  });
});

test('shows a restart action for a cancelled session', () => {
  const restart = rs.fn();
  render(
    <OAuthAuthorizationPanel
      session={{ id: '550e8400-e29b-41d4-a716-446655440000', status: 'cancelled' }}
      onSubmitCallback={rs.fn()}
      onCancel={restart}
      isPending={false}
    />,
  );

  expect(screen.getByText(/authorization was cancelled|授权已取消/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Start over|重新开始/u }));
  expect(restart).toHaveBeenCalledTimes(1);
});

test('renders the authorize_url branch with localized instructions, an open link, and cancel', () => {
  render(
    <OAuthAuthorizationPanel
      session={{
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'authorize_url',
        url: 'https://cursor.com/loginDeepControl',
        instructions: { default: 'Finish signing in from the opened page', 'zh-Hans': '请在打开的页面中完成登录' },
      }}
      onSubmitCallback={rs.fn()}
      onCancel={rs.fn()}
      isPending={false}
    />,
  );

  expect(screen.getByRole('button', { name: /open authorization page|打开授权页面/iu })).toHaveAttribute(
    'href',
    'https://cursor.com/loginDeepControl',
  );
  expect(screen.getByDisplayValue('https://cursor.com/loginDeepControl')).toHaveAttribute('readonly');
  expect(screen.getByText(/Finish signing in from the opened page|请在打开的页面中完成登录/u)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /cancel|取消/iu })).toBeInTheDocument();
});

// The session hook pre-opens one window on the user's click and navigates it when the URL arrives
// (`use-oauth-editor-session.ts`). The panel used to `window.open` the same URL again on render, which
// gave every authorize_url provider two authorization tabs.
test('does not open a second authorization window', async () => {
  const open = rs.fn();
  const original = window.open;
  Object.defineProperty(window, 'open', { writable: true, configurable: true, value: open });
  Object.defineProperty(navigator, 'clipboard', {
    writable: true,
    configurable: true,
    value: { writeText: async () => undefined },
  });

  try {
    render(
      <OAuthAuthorizationPanel
        session={{
          id: '550e8400-e29b-41d4-a716-446655440000',
          status: 'device_code',
          url: 'https://x.ai/device',
          userCode: 'ABCD-EFGH',
        }}
        onSubmitCallback={rs.fn()}
        onCancel={rs.fn()}
        isPending={false}
      />,
    );

    await waitFor(() => expect(screen.getByDisplayValue('https://x.ai/device')).toBeTruthy());
    expect(open).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(window, 'open', { writable: true, configurable: true, value: original });
  }
});
