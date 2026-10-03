import { expect, test } from 'bun:test';

import { decodeOutput } from './run-capture';

const xml = '<?xml version="1.0" encoding="UTF-16"?>\n<Task><UserId>Zoë</UserId></Task>';

test('UTF-16LE output is decoded with or without a BOM, and UTF-8 output stays UTF-8', () => {
  expect(decodeOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))).toBe(xml);
  expect(decodeOutput(Buffer.from(xml, 'utf16le'))).toBe(xml);
  expect(decodeOutput(Buffer.from(xml, 'utf8'))).toBe(xml);
  expect(decodeOutput(new Uint8Array())).toBe('');
});
