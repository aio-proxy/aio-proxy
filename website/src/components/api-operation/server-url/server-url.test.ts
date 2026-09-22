import { describe, expect, test } from 'bun:test';

import { InvalidDocumentationServerError, selectedServer } from './server-url';

describe('selectedServer', () => {
  test('accepts an absolute HTTP server outside the documentation origin', () => {
    expect(selectedServer('https://proxy.example', 'https://aioproxy.dev')).toBe('https://proxy.example');
  });

  test.each([
    ['', 'empty server'],
    ['/v1', 'absolute HTTP or HTTPS server'],
    ['ftp://proxy.example', 'HTTP or HTTPS server'],
    ['https://aioproxy.dev', 'documentation origin'],
    ['https://aioproxy.dev/v1', 'documentation origin'],
  ])('rejects unsafe server %p', (input, message) => {
    expect(() => selectedServer(input, 'https://aioproxy.dev')).toThrow(InvalidDocumentationServerError);
    expect(() => selectedServer(input, 'https://aioproxy.dev')).toThrow(message);
  });
});
