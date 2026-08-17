import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const codeEditorHighlightStyle = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--code-editor-property)' },
  { tag: t.string, color: 'var(--code-editor-string)' },
  { tag: t.number, color: 'var(--code-editor-number)' },
  { tag: [t.bool, t.null, t.keyword], color: 'var(--code-editor-keyword)' },
  { tag: t.comment, color: 'var(--code-editor-comment)' },
  {
    tag: [t.punctuation, t.bracket, t.squareBracket, t.brace, t.separator],
    color: 'var(--code-editor-punctuation)',
  },
  { tag: t.invalid, color: 'var(--code-editor-error)' },
]);

export const codeEditorTheme = [
  EditorView.theme({
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--code-editor-foreground)',
      height: '100%',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-scroller': {
      overflow: 'auto',
    },
    '.cm-content': {
      caretColor: 'var(--code-editor-accent-strong)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--code-editor-accent-strong)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--code-editor-selection)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--code-editor-line-highlight)',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--code-editor-muted)',
      border: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--code-editor-line-highlight)',
    },
    '.cm-diagnostic-error': {
      borderLeftColor: 'var(--code-editor-error)',
    },
    '.cm-diagnostic-warning': {
      borderLeftColor: 'var(--code-editor-warning)',
    },
    '.cm-tooltip.cm-tooltip-hover:has(> .cm-tooltip-lint)': {
      overflow: 'hidden',
      padding: 0,
      borderRadius: '0.75rem',
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
      fontFamily: 'var(--font-sans)',
    },
    '.cm-tooltip-lint.cm-tooltip-section': {
      borderTop: 'none',
    },
    '.cm-tooltip-lint .cm-diagnostic': {
      marginLeft: 0,
      borderLeft: 'none',
      padding: '0.5rem 0.75rem',
    },
    '.cm-tooltip-lint .cm-diagnostic-error': {
      color: 'var(--destructive)',
    },
    '.cm-tooltip-lint .cm-diagnostic-warning': {
      color: 'var(--code-editor-warning)',
    },
    '.cm-tooltip': {
      border: 'none',
      backgroundColor: 'var(--code-editor-surface)',
      color: 'var(--code-editor-muted)',
      borderRadius: '1rem',
      boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 0 0 1px var(--code-editor-tooltip-ring)',
    },
    '.cm-tooltip.cm-tooltip-hover': {
      maxWidth: '20rem',
      overflow: 'hidden',
      padding: '0.5rem 0.75rem',
      fontSize: '0.75rem',
      lineHeight: 1.5,
    },
    '.cm-tooltip-hover .typeset': {
      fontSize: 'inherit',
      lineHeight: 'inherit',
    },
    '.cm-tooltip-hover code, .cm-completionInfo code': {
      borderRadius: '0.375rem',
      backgroundColor: 'var(--code-editor-tooltip-code)',
      color: 'var(--code-editor-foreground)',
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
      backgroundColor: 'var(--code-editor-line-highlight)',
      color: 'var(--code-editor-foreground)',
    },
    '.cm-tooltip.cm-completionInfo': {
      padding: '0.75rem',
      maxWidth: '20rem',
      whiteSpace: 'normal',
      fontSize: '0.875rem',
      lineHeight: '1.625',
    },
  }),
  syntaxHighlighting(codeEditorHighlightStyle),
];
