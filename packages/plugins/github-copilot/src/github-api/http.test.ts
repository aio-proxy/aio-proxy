import { describe, expect, test } from 'bun:test';

import { copilotHeaders, githubUserHeaders } from './http';

describe('GitHub Copilot HTTP headers', () => {
  // GitHub REST reads authenticate with the long-lived GitHub OAuth token under the `token`
  // scheme; the Copilot API takes the short-lived Copilot token as a `Bearer`. Swapping either
  // is a 401 that only shows up against the real upstream.
  test('authenticates GitHub REST reads with the token scheme', () => {
    const headers = new Headers(githubUserHeaders('github-token'));

    expect(headers.get('authorization')).toBe('token github-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('x-github-api-version')).toBe('2025-04-01');
  });

  // Both builders impersonate the same editor. Bumping one and not the other makes the two halves
  // of this plugin claim different clients, which upstream is entitled to treat differently.
  test('presents one editor identity across both header builders', () => {
    const rest = new Headers(githubUserHeaders('github-token'));
    const copilot = new Headers(copilotHeaders('copilot-token'));

    for (const key of ['editor-version', 'editor-plugin-version', 'user-agent']) {
      expect(rest.get(key)).toBe(copilot.get(key));
    }
    expect(copilot.get('editor-version')).toBe('vscode/1.107.0');
  });
});
