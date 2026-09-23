import { describe, expect, test } from 'bun:test';

import { canPrompt, useColor, type PromptIo } from './mode';

const tty = (env: NodeJS.ProcessEnv = {}): PromptIo => ({
  stdinIsTTY: true,
  stderrIsTTY: true,
  env,
});

describe('canPrompt', () => {
  test('prompts only when stdin and stderr are TTYs and CI is unset, empty, 0, or false', () => {
    expect(canPrompt(tty())).toBe(true);
    expect(canPrompt(tty({ CI: '' }))).toBe(true);
    expect(canPrompt(tty({ CI: '0' }))).toBe(true);
    expect(canPrompt(tty({ CI: 'false' }))).toBe(true);
    expect(canPrompt(tty({ CI: 'true' }))).toBe(false);
    expect(canPrompt(tty({ CI: '1' }))).toBe(false);
    expect(canPrompt({ ...tty(), stdinIsTTY: false })).toBe(false);
    expect(canPrompt({ ...tty(), stderrIsTTY: false })).toBe(false);
  });

  test('stdout TTY and NO_COLOR do not decide prompting', () => {
    expect(canPrompt(tty({ NO_COLOR: '' }))).toBe(true);
    expect(canPrompt(tty({ NO_COLOR: '1' }))).toBe(true);
  });
});

describe('useColor', () => {
  test('colors only a TTY stream when NO_COLOR is unset', () => {
    expect(useColor(true, {})).toBe(true);
    expect(useColor(true, { NO_COLOR: '' })).toBe(false);
    expect(useColor(true, { NO_COLOR: '1' })).toBe(false);
    expect(useColor(false, {})).toBe(false);
  });
});
