import { describe, expect, test } from 'bun:test';

import { colorDepth, createStyle, plainStyle, styleFor } from './style';

const ESC = '\u001B';

describe('colorDepth', () => {
  test('is none without a TTY or with NO_COLOR', () => {
    expect(colorDepth(false, { COLORTERM: 'truecolor' })).toBe('none');
    expect(colorDepth(true, { NO_COLOR: '', COLORTERM: 'truecolor' })).toBe('none');
  });

  test('reads COLORTERM, then TERM, then falls back to 16 colors', () => {
    expect(colorDepth(true, { COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(colorDepth(true, { COLORTERM: '24bit' })).toBe('truecolor');
    expect(colorDepth(true, { TERM: 'xterm-256color' })).toBe('256');
    expect(colorDepth(true, { TERM: 'xterm' })).toBe('16');
  });

  test('is none on a dumb terminal', () => {
    expect(colorDepth(true, { TERM: 'dumb' })).toBe('none');
  });
});

describe('styleFor', () => {
  test('plain style leaves text and symbols untouched', () => {
    expect(plainStyle.heading('Server')).toBe('Server');
    expect(plainStyle.mark('ok')).toBe('●');
    expect(plainStyle.mark('warn')).toBe('▲');
    expect(plainStyle.mark('fail')).toBe('✗');
    expect(plainStyle.mark('off')).toBe('○');
    expect(plainStyle.mark('hint')).toBe('→');
    expect(createStyle({ isTTY: false }, {}).danger('x')).toBe('x');
  });

  test('16-color warnings are yellow, never red', () => {
    const warning = styleFor('16').warning('stale');
    expect(warning).toContain(`${ESC}[33m`);
    expect(warning).not.toContain(`${ESC}[31m`);
    expect(warning).not.toContain(`${ESC}[91m`);
  });

  test('truecolor headings are bold Dashboard teal', () => {
    expect(styleFor('truecolor').heading('Server')).toBe(`${ESC}[1m${ESC}[38;2;0;150;137mServer${ESC}[0m`);
  });

  test('256-color success uses the nearest palette index for teal', () => {
    expect(styleFor('256').success('ready')).toBe(`${ESC}[38;5;30mready${ESC}[0m`);
  });

  test('strong is bold without a color', () => {
    expect(styleFor('16').strong('run')).toBe(`${ESC}[1mrun${ESC}[0m`);
  });
});
