import { afterEach, describe, expect, jest, test } from 'bun:test';

import { loginToGitHubCopilot } from '.';
import { deviceFlowFetch, flushMicrotasks, loginContext, waitUntil, withFetchMock } from './login.test-support';

afterEach(() => {
  jest.useRealTimers();
});

describe('GitHub Copilot login', () => {
  test('adds five seconds after slow_down before polling again', async () => {
    jest.useFakeTimers();
    let polls = 0;
    const login = withFetchMock(
      deviceFlowFetch({
        tokenResponses: [{ error: 'slow_down' }, { access_token: 'github-token' }],
        onTokenPoll: () => polls++,
      }),
      () => loginToGitHubCopilot(loginContext(), { deploymentType: 'github.com' }),
    );

    await waitUntil(() => polls === 1);
    await flushMicrotasks();
    expect(polls).toBe(1);
    jest.advanceTimersByTime(4_999);
    await flushMicrotasks();
    expect(polls).toBe(1);
    jest.advanceTimersByTime(1);

    await expect(login).resolves.toMatchObject({ fingerprint: '12345' });
    expect(polls).toBe(2);
  });

  test('surfaces device authorization denial', async () => {
    await withFetchMock(deviceFlowFetch({ tokenResponses: [{ error: 'access_denied' }] }), async () => {
      await expect(loginToGitHubCopilot(loginContext(), { deploymentType: 'github.com' })).rejects.toThrow(
        'access_denied',
      );
    });
  });

  test('times out when device authorization expires', async () => {
    jest.useFakeTimers();
    let polls = 0;
    const login = withFetchMock(
      deviceFlowFetch({
        expiresIn: 1,
        interval: 5,
        tokenResponses: [{ error: 'authorization_pending' }],
        onTokenPoll: () => polls++,
      }),
      () => loginToGitHubCopilot(loginContext(), { deploymentType: 'github.com' }),
    );

    await waitUntil(() => polls === 1);
    await flushMicrotasks();
    jest.advanceTimersByTime(5_000);

    await expect(login).rejects.toThrow('GitHub device authorization timed out');
  });

  test('aborts while waiting for the next device poll', async () => {
    const controller = new AbortController();
    let polls = 0;
    const login = withFetchMock(
      deviceFlowFetch({
        interval: 30,
        tokenResponses: [{ error: 'authorization_pending' }],
        onTokenPoll: () => polls++,
      }),
      () =>
        loginToGitHubCopilot(loginContext({ signal: controller.signal }), {
          deploymentType: 'github.com',
        }),
    );

    await waitUntil(() => polls === 1);
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(login).rejects.toMatchObject({ name: 'AbortError' });
    expect(polls).toBe(1);
  });
});
