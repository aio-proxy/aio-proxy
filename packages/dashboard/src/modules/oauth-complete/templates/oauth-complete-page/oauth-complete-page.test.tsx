import { m } from '@aio-proxy/i18n';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { OAuthCompletePage } from './oauth-complete-page';

afterEach(() => {
  rs.useFakeTimers({ now: 0 });
  rs.useRealTimers();
});

test('shows the completion page immediately and closes after two seconds', () => {
  rs.useFakeTimers({ now: 0 });
  const postMessage = rs.fn();
  const close = rs.fn();
  Object.defineProperty(window, 'opener', { configurable: true, value: { postMessage } });
  Object.defineProperty(window, 'close', { configurable: true, value: close });

  render(<OAuthCompletePage />);

  expect(screen.getByRole('heading', { name: m['dashboard.oauth_complete.title']() })).toBeInTheDocument();
  expect(screen.getByText(m['dashboard.oauth_complete.description']())).toBeInTheDocument();
  expect(postMessage).toHaveBeenCalledWith({ type: 'aio-proxy:oauth-complete' }, window.location.origin);
  expect(close).not.toHaveBeenCalled();

  rs.advanceTimersByTime(1999);
  expect(close).not.toHaveBeenCalled();
  rs.advanceTimersByTime(1);
  expect(close).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.oauth_complete.close']() }));
  expect(close).toHaveBeenCalledTimes(2);
});
