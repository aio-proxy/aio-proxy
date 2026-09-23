import { expect, test } from 'bun:test';

import { renderTemplate } from '.';

test('interpolates plugin variables without escaping HTTP values or evaluating their contents again', () => {
  expect(
    renderTemplate('agent/{{ version }} ({{details}})', (name) => {
      if (name === 'version') return '1.2.3';
      if (name === 'details') return 'A&B; {{private}}';
      throw new Error('unexpected variable');
    }),
  ).toBe('agent/1.2.3 (A&B; {{private}})');
});

test.each([
  '{{helper version}}',
  '{{#if version}}yes{{/if}}',
  '{{{version}}}',
  '{{this.version}}',
  '{{../version}}',
  '{{version.[value]}}',
  '{{>partial}}',
])('rejects expressions instead of invoking the variable resolver: %s', (template) => {
  const variables: string[] = [];
  expect(() =>
    renderTemplate(template, (name) => {
      variables.push(name);
      return 'value';
    }),
  ).toThrow('Unsupported template');
  expect(variables).toEqual([]);
});
