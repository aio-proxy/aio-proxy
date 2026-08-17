import { describe, expect, test } from '@rstest/core';

import { markdownToDom } from './json-markup';

const textOf = (markdown: string) => {
  const container = document.createElement('div');
  container.append(markdownToDom(markdown));
  return container;
};

describe('json markup', () => {
  test('unescapes markdown punctuation in schema descriptions', () => {
    expect(textOf('Base URL for the API calls\\.').textContent?.trim()).toBe('Base URL for the API calls.');
  });

  test('renders schema descriptions as markdown', () => {
    const container = textOf('Adds an `Authorization` header.\n\nUse **HTTPS**.\n\n- one\n- two');
    expect(container.querySelector('.typeset')).not.toBeNull();
    expect(container.querySelector('p')).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('Authorization');
    expect(container.querySelector('strong')?.textContent).toBe('HTTPS');
    expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['one', 'two']);
  });
});
