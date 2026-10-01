import type { Style } from '../style';

export type TableRow = {
  readonly mark?: string;
  readonly cells: readonly string[];
  readonly notes?: readonly string[];
};
export type Field = readonly [label: string, value: string];
export type Block = {
  readonly mark: string;
  readonly title: string;
  readonly fields: readonly Field[];
  readonly notes?: readonly string[];
};

const GAP = '  ';
const INDENT = '    ';

// Bun.stringWidth ignores ANSI escapes, so cells may arrive already styled.
const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - Bun.stringWidth(text)));

function align(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, Bun.stringWidth(cell));
    });
  }
  return rows.map((row) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : pad(cell, widths[index]!))).join(GAP),
  );
}

export function formatTable(style: Style, rows: readonly TableRow[], headers?: readonly string[]): string[] {
  const gutter = rows.some((row) => row.mark !== undefined);
  const lead = (mark: string | undefined): string => (gutter ? `${mark ?? ' '} ` : '');
  const head = headers === undefined ? [] : [headers.map((header) => header.toLocaleUpperCase())];
  const lines = align([...head, ...rows.map((row) => row.cells)]);
  const out = head.length === 0 ? [] : [lead(undefined) + style.muted(lines[0]!)];
  rows.forEach((row, index) => {
    out.push(lead(row.mark) + lines[index + head.length]!);
    for (const note of row.notes ?? []) out.push(INDENT + note);
  });
  return out;
}

export function formatBlock(style: Style, block: Block): string[] {
  const width = Math.max(0, ...block.fields.map(([label]) => Bun.stringWidth(label)));
  return [
    `${block.mark} ${block.title}`,
    ...block.fields.map(([label, value]) => `${INDENT}${style.muted(pad(label, width))}${GAP}${value}`),
    ...(block.notes ?? []).map((note) => INDENT + note),
  ];
}

export function formatBlocks(style: Style, blocks: readonly Block[]): string[] {
  return blocks.flatMap((block, index) => [...(index === 0 ? [] : ['']), ...formatBlock(style, block)]);
}
