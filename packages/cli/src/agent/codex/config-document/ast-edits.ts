import type { AST } from 'toml-eslint-parser';

export type SourceEdit = { readonly start: number; readonly end: number; readonly text: string };

export const keyParts = (key: AST.TOMLKey): string[] =>
  key.keys.map((part) => (part.type === 'TOMLBare' ? part.name : part.value));

export const samePath = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

export const isPrefix = (prefix: readonly string[], path: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((part, index) => part === path[index]);

export const encodeTomlKey = (value: string): string =>
  /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);

export type TomlLeaf = string | boolean | number | readonly string[];

export const encodeTomlValue = (value: TomlLeaf): string => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
};

export const applySourceEdits = (source: string, edits: readonly SourceEdit[]): string => {
  const merged: Array<{ start: number; end: number; text: string }> = [];
  const insertionByStart = new Map<number, { start: number; end: number; text: string }>();
  for (const edit of edits) {
    if (edit.start === edit.end) {
      const prior = insertionByStart.get(edit.start);
      if (prior !== undefined) {
        prior.text += edit.text;
      } else {
        const insertion = { ...edit };
        insertionByStart.set(edit.start, insertion);
        merged.push(insertion);
      }
    } else {
      merged.push(edit);
    }
  }
  const ordered = merged.sort((left, right) => right.start - left.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.end > ordered[index - 1]!.start) {
      throw new Error('Overlapping TOML source edits');
    }
  }
  let result = source;
  for (const edit of ordered) result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  return result;
};

export const lineEndingFor = (source: string): '\n' | '\r\n' => (source.includes('\r\n') ? '\r\n' : '\n');

export const lineStart = (source: string, offset: number): number => {
  const before = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return before < 0 ? 0 : before + 1;
};

export const lineEnd = (source: string, offset: number): number => {
  const newline = source.indexOf('\n', offset);
  return newline < 0 ? source.length : newline;
};

export const textAfterLine = (source: string, offset: number): number => {
  const newline = source.indexOf('\n', offset);
  return newline < 0 ? source.length : newline + 1;
};

export type InlineOperation =
  | { readonly kind: 'replace'; readonly start: number; readonly end: number; readonly text: string }
  | { readonly kind: 'insert'; readonly start: number; readonly text: string }
  | { readonly kind: 'delete'; readonly start: number; readonly end: number };

export const inlineMemberDelete = (
  source: string,
  members: readonly AST.TOMLKeyValue[],
  target: AST.TOMLKeyValue,
): InlineOperation => {
  const index = members.indexOf(target);
  if (index < 0) throw new Error('Inline TOML member is not in its parent table');
  const next = members[index + 1];
  if (next !== undefined) {
    return { kind: 'delete', start: target.range[0], end: next.range[0] };
  }
  const previous = members[index - 1];
  if (previous === undefined) return { kind: 'delete', start: target.range[0], end: target.range[1] };
  let comma = target.range[0] - 1;
  while (comma > previous.range[1] && /[ \t]/.test(source[comma]!)) comma -= 1;
  if (source[comma] === ',') return { kind: 'delete', start: comma, end: target.range[1] };
  return { kind: 'delete', start: target.range[0], end: target.range[1] };
};

export const applyInlineOperations = (
  source: string,
  range: readonly [number, number],
  operations: readonly InlineOperation[],
): SourceEdit => {
  const insertText = new Map<number, string>();
  const local: SourceEdit[] = [];
  for (const operation of operations) {
    if (operation.kind === 'insert') {
      insertText.set(operation.start, `${insertText.get(operation.start) ?? ''}${operation.text}`);
    } else {
      local.push({
        start: operation.start,
        end: operation.end,
        text: operation.kind === 'delete' ? '' : operation.text,
      });
    }
  }
  for (const [start, text] of insertText) local.push({ start, end: start, text });
  return {
    start: range[0],
    end: range[1],
    text: applySourceEdits(
      source.slice(range[0], range[1]),
      local.map((edit) => ({
        ...edit,
        start: edit.start - range[0],
        end: edit.end - range[0],
      })),
    ),
  };
};
