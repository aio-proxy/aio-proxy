import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

import { type CodeEditorColor, type EditorPalette, toCssColor } from './theme-colors';

const LIGHT_JSON_PROPERTY_COLOR = {
  from: '--color-cyan-400',
  to: '--color-neutral-500',
  toAmount: 0.75,
} as const satisfies CodeEditorColor;

const LIGHT_STRING_COLOR = {
  from: '--color-red-500',
  to: '--color-olive-500',
  toAmount: 0.6,
} as const satisfies CodeEditorColor;

const LIGHT_PUNCTUATION_COLOR = {
  from: '--color-neutral-500',
  to: '--color-neutral-400',
  toAmount: 0.61,
} as const satisfies CodeEditorColor;

const DARK_JSON_PROPERTY_COLOR = {
  from: '--color-cyan-700',
  to: '--color-taupe-400',
  toAmount: 0.51,
} as const satisfies CodeEditorColor;

const DARK_STRING_COLOR = {
  from: '--color-red-400',
  to: '--color-taupe-400',
  toAmount: 0.5,
} as const satisfies CodeEditorColor;

const DARK_NUMBER_COLOR = {
  from: '--color-sky-600',
  to: '--color-slate-400',
  toAmount: 0.58,
} as const satisfies CodeEditorColor;

const DARK_KEYWORD_COLOR = {
  from: '--color-teal-600',
  to: '--color-olive-500',
  toAmount: 0.36,
} as const satisfies CodeEditorColor;

const DARK_PUNCTUATION_COLOR = {
  from: '--color-neutral-500',
  to: '--color-neutral-400',
  toAmount: 0.4,
} as const satisfies CodeEditorColor;

const LIGHT_EDITOR_PALETTE = {
  foreground: '--color-neutral-700',
  surface: '--color-olive-50',
  muted: '--color-mist-500',
  subtle: '--color-neutral-400',
  accent: '--color-sky-700',
  accentStrong: '--color-green-800',
  warning: '--color-amber-700',
  error: '--color-red-800',
  punctuation: LIGHT_PUNCTUATION_COLOR,
} as const satisfies EditorPalette;

const DARK_EDITOR_PALETTE = {
  foreground: '--color-taupe-300',
  surface: '--color-neutral-800',
  muted: '--color-olive-500',
  subtle: '--color-neutral-500',
  accent: '--color-teal-600',
  accentStrong: '--color-cyan-500',
  warning: '--color-amber-500',
  error: '--color-red-400',
  punctuation: DARK_PUNCTUATION_COLOR,
} as const satisfies EditorPalette;

type JsonTokenColors = {
  readonly property: CodeEditorColor;
  readonly string: CodeEditorColor;
  readonly number: CodeEditorColor;
  readonly keyword: CodeEditorColor;
  readonly comment: CodeEditorColor;
};

const LIGHT_JSON_TOKENS = {
  property: LIGHT_JSON_PROPERTY_COLOR,
  string: LIGHT_STRING_COLOR,
  number: '--color-sky-700',
  keyword: '--color-green-800',
  comment: '--color-olive-400',
} as const satisfies JsonTokenColors;

const DARK_JSON_TOKENS = {
  property: DARK_JSON_PROPERTY_COLOR,
  string: DARK_STRING_COLOR,
  number: DARK_NUMBER_COLOR,
  keyword: DARK_KEYWORD_COLOR,
  comment: '--color-olive-500',
} as const satisfies JsonTokenColors;

const createHighlightStyle = (tokens: JsonTokenColors, punctuation: CodeEditorColor, error: CodeEditorColor) =>
  HighlightStyle.define([
    { tag: t.propertyName, color: toCssColor(tokens.property) },
    { tag: t.string, color: toCssColor(tokens.string) },
    { tag: t.number, color: toCssColor(tokens.number) },
    { tag: t.bool, color: toCssColor(tokens.keyword) },
    { tag: t.null, color: toCssColor(tokens.keyword) },
    { tag: t.keyword, color: toCssColor(tokens.keyword) },
    { tag: t.comment, color: toCssColor(tokens.comment) },
    { tag: t.punctuation, color: toCssColor(punctuation) },
    { tag: t.bracket, color: toCssColor(punctuation) },
    { tag: t.squareBracket, color: toCssColor(punctuation) },
    { tag: t.brace, color: toCssColor(punctuation) },
    { tag: t.separator, color: toCssColor(punctuation) },
    { tag: t.invalid, color: toCssColor(error) },
  ]);

const createEditorTheme = (palette: EditorPalette, dark: boolean) => {
  const surface = toCssColor(palette.surface);
  const foreground = toCssColor(palette.foreground);
  const muted = toCssColor(palette.muted);
  const selection = toCssColor(palette.accent, 0.24);
  const lineHighlight = toCssColor(palette.subtle, 0.16);
  const caret = toCssColor(palette.accentStrong);
  const error = toCssColor(palette.error);
  const warning = toCssColor(palette.warning);
  const tooltipRing = toCssColor(palette.foreground, dark ? 0.1 : 0.05);
  const tooltipCode = toCssColor(palette.foreground, 0.1);

  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'transparent',
        color: foreground,
        height: '100%',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-scroller': {
        overflow: 'auto',
      },
      '.cm-content': {
        caretColor: caret,
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: caret,
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: selection,
      },
      '.cm-activeLine': {
        backgroundColor: lineHighlight,
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: muted,
        border: 'none',
      },
      '.cm-activeLineGutter': {
        backgroundColor: lineHighlight,
      },
      '.cm-diagnostic-error': {
        borderLeftColor: error,
      },
      '.cm-diagnostic-warning': {
        borderLeftColor: warning,
      },
      '.cm-tooltip': {
        border: 'none',
        backgroundColor: surface,
        color: muted,
        borderRadius: '1rem',
        boxShadow: `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 0 0 1px ${tooltipRing}`,
      },
      '.cm-tooltip.cm-tooltip-hover': {
        maxWidth: '20rem',
        overflow: 'hidden',
        padding: '0.5rem 0.75rem',
        fontSize: '0.875rem',
        lineHeight: '1.625',
      },
      '.cm-tooltip-hover code, .cm-completionInfo code': {
        borderRadius: '0.375rem',
        backgroundColor: tooltipCode,
        color: foreground,
        padding: '0.125rem 0.25rem',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'inherit',
        minWidth: '12rem',
        maxHeight: '16rem',
        padding: '0.25rem',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        padding: '0.375rem 0.5rem',
        borderRadius: '0.75rem',
        lineHeight: 1.4,
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: lineHighlight,
        color: foreground,
      },
      '.cm-tooltip.cm-completionInfo': {
        padding: '0.75rem',
        maxWidth: '20rem',
        whiteSpace: 'normal',
        fontSize: '0.875rem',
        lineHeight: '1.625',
      },
    },
    { dark },
  );
};

export const createCodeEditorTheme = (mode: 'light' | 'dark'): Extension[] => {
  const palette = mode === 'dark' ? DARK_EDITOR_PALETTE : LIGHT_EDITOR_PALETTE;
  const tokens = mode === 'dark' ? DARK_JSON_TOKENS : LIGHT_JSON_TOKENS;
  return [
    createEditorTheme(palette, mode === 'dark'),
    syntaxHighlighting(createHighlightStyle(tokens, palette.punctuation, palette.error)),
  ];
};
