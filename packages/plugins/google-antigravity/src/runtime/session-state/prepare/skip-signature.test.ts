import { expect, test } from 'bun:test';

import { applyGeminiSkipThoughtSignature } from './skip-signature';

const SKIP = 'skip_thought_signature_validator';
const SIGNED = 's'.repeat(50);

test('fills skip sentinel only on the first unsigned Gemini function call', () => {
  const body = {
    contents: [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }],
      },
    ],
  };
  const prepared = applyGeminiSkipThoughtSignature(body, 'gemini-3-flash-agent') as {
    contents: Array<{ parts: Array<{ thoughtSignature?: string }> }>;
  };
  expect(prepared.contents[0]?.parts[0]?.thoughtSignature).toBe(SKIP);
  expect(prepared.contents[0]?.parts[1]?.thoughtSignature).toBeUndefined();
});

test('does not skip after a signed first call', () => {
  const body = {
    contents: [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'a', args: {} }, thoughtSignature: SIGNED },
          { functionCall: { name: 'b', args: {} } },
        ],
      },
    ],
  };
  const prepared = applyGeminiSkipThoughtSignature(body, 'gemini-3-flash-agent') as {
    contents: Array<{ parts: Array<{ thoughtSignature?: string }> }>;
  };
  expect(prepared.contents[0]?.parts[1]?.thoughtSignature).toBeUndefined();
});

test('does not skip Claude function calls', () => {
  const body = {
    contents: [{ role: 'model', parts: [{ functionCall: { name: 'a', args: {} } }] }],
  };
  expect(applyGeminiSkipThoughtSignature(body, 'claude-sonnet-4-6')).toEqual(body);
});
