import { describe, expect, test } from 'bun:test';

import { plainStyle, styleFor } from '../style';
import { formatBlock, formatBlocks, formatTable } from './layout';

const columnOf = (line: string, text: string): number => Bun.stringWidth(line.slice(0, line.indexOf(text)));

describe('formatTable', () => {
  test('aligns columns by display width across CJK and ASCII', () => {
    const lines = formatTable(plainStyle, [{ cells: ['字字字', 'x'] }, { cells: ['ab', 'y'] }], ['名称', 'v']);
    expect(columnOf(lines[0]!, 'V')).toBe(columnOf(lines[1]!, 'x'));
    expect(columnOf(lines[1]!, 'x')).toBe(columnOf(lines[2]!, 'y'));
  });

  test('upper-cases headers and does not pad the last column', () => {
    const lines = formatTable(plainStyle, [{ cells: ['a', 'b'] }], ['id', 'kind']);
    expect(lines).toEqual(['ID  KIND', 'a   b']);
  });

  test('adds a mark gutter and indents notes past it', () => {
    const lines = formatTable(plainStyle, [{ mark: '●', cells: ['a', 'b'], notes: ['→ fix'] }], ['id', 'kind']);
    expect(lines).toEqual(['  ID  KIND', '● a   b', '    → fix']);
  });

  test('aligns cells that already carry color', () => {
    const style = styleFor('16');
    const lines = formatTable(style, [{ cells: [style.success('ready'), 'x'] }, { cells: ['unavailable', 'y'] }]);
    expect(columnOf(lines[0]!, 'x')).toBe(columnOf(lines[1]!, 'y'));
  });

  test('keeps a 200-character cell whole', () => {
    const id = 'x'.repeat(200);
    expect(formatTable(plainStyle, [{ cells: [id, 'b'] }]).join('\n')).toContain(id);
  });
});

describe('formatBlock', () => {
  test('aligns values after the widest label, including CJK labels', () => {
    const lines = formatBlock(plainStyle, {
      mark: '●',
      title: 'pi  managed',
      fields: [
        ['主机', '0.99.2'],
        ['endpoint', 'http://127.0.0.1:9317'],
      ],
      notes: ['▲ drifted'],
    });
    expect(lines[0]).toBe('● pi  managed');
    expect(columnOf(lines[1]!, '0.99.2')).toBe(columnOf(lines[2]!, 'http'));
    expect(lines[1]!.startsWith('    ')).toBe(true);
    expect(lines[3]).toBe('    ▲ drifted');
  });

  test('separates blocks with exactly one blank line', () => {
    const block = { mark: '●', title: 't', fields: [] };
    expect(formatBlocks(plainStyle, [block, block])).toEqual(['● t', '', '● t']);
  });
});
