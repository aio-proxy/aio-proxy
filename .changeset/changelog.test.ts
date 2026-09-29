import { describe, expect, test } from 'bun:test';

import { getReleaseLine, renderReleaseLine, stripGitHubAuthorLinks } from './changelog';

describe('stripGitHubAuthorLinks', () => {
  test('keeps the author mention while removing the profile link', () => {
    const line =
      '- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) Thanks [@baranwang](https://github.com/baranwang) - xxxx';

    expect(stripGitHubAuthorLinks(line)).toBe(
      '- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) Thanks @baranwang - xxxx',
    );
  });

  test('removes the default attribution exclamation before the summary', () => {
    expect(
      renderReleaseLine('Thanks [@baranwang](https://github.com/baranwang)! - xxxx', {
        removeThanksPunctuation: true,
      }),
    ).toBe('Thanks @baranwang - xxxx');
    expect(
      renderReleaseLine(
        'Thanks [@baranwang](https://github.com/baranwang), [@aio-proxy](https://github.com/aio-proxy)! - xxxx',
      ),
    ).toBe('Thanks @baranwang, @aio-proxy - xxxx');
  });

  test('only removes punctuation from the generated attribution', () => {
    const line =
      '\n\n- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) Thanks [@author](https://github.com/author)! - Thanks [@baranwang](https://github.com/baranwang)! - hello\n';

    expect(renderReleaseLine(line, { removeThanksPunctuation: true })).toBe(
      '\n\n- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) Thanks @author - Thanks @baranwang! - hello\n',
    );
  });

  test('leaves non-GitHub profile links untouched', () => {
    const line = 'Thanks [@baranwang](https://example.com/baranwang)! - xxxx';

    expect(stripGitHubAuthorLinks(line)).toBe(line);
  });

  test('does not remove punctuation from a summary when attribution is disabled', () => {
    const line = 'Thanks @baranwang! - xxxx';

    expect(renderReleaseLine(line, { removeThanksPunctuation: false })).toBe(line);
  });

  test('does not rewrite a summary that only resembles an attribution', async () => {
    const line = await getReleaseLine(
      { summary: 'Thanks [@baranwang](https://github.com/baranwang)! - hello' },
      'patch',
      { repo: 'aio-proxy/aio-proxy' },
    );

    expect(line).toBe('\n\n- Thanks @baranwang! - hello\n');
  });
});
