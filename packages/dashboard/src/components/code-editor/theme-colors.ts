export type TailwindColorVariable = `--color-${string}`;
export type CodeEditorColorMix = {
  readonly from: TailwindColorVariable;
  readonly to: TailwindColorVariable;
  readonly toAmount: number;
};
export type CodeEditorColor = TailwindColorVariable | CodeEditorColorMix;
export type CodeEditorColorResolver = (color: CodeEditorColor, opacity?: number) => string;
export type ColorReference = readonly [color: CodeEditorColor, opacity?: number];

export type EditorPalette = {
  readonly background: ColorReference;
  readonly foreground: CodeEditorColor;
  readonly surface: ColorReference;
  readonly minimap: ColorReference;
  readonly muted: CodeEditorColor;
  readonly subtle: CodeEditorColor;
  readonly border: CodeEditorColor;
  readonly accent: CodeEditorColor;
  readonly accentStrong: CodeEditorColor;
  readonly success: CodeEditorColor;
  readonly warning: CodeEditorColor;
  readonly error: CodeEditorColor;
  readonly punctuation: CodeEditorColor;
};

const resolveColorReference = ([variable, opacity]: ColorReference, resolveColor: CodeEditorColorResolver) =>
  resolveColor(variable, opacity);

export const createEditorColors = (palette: EditorPalette, resolveColor: CodeEditorColorResolver) => ({
  focusBorder: resolveColor(palette.accent, 0.5),
  "editor.background": resolveColorReference(palette.background, resolveColor),
  "editor.foreground": resolveColor(palette.foreground),
  "editorCursor.foreground": resolveColor(palette.accentStrong),
  "editorGutter.background": resolveColorReference(palette.background, resolveColor),
  "editorLineNumber.foreground": resolveColor(palette.muted),
  "editorLineNumber.activeForeground": resolveColor(palette.foreground),
  "editor.lineHighlightBackground": resolveColor(palette.subtle, 0.16),
  "editor.selectionBackground": resolveColor(palette.accent, 0.24),
  "editor.inactiveSelectionBackground": resolveColor(palette.accent, 0.14),
  "editor.selectionHighlightBackground": resolveColor(palette.accent, 0.14),
  "editor.wordHighlightBackground": resolveColor(palette.accent, 0.12),
  "editor.wordHighlightStrongBackground": resolveColor(palette.success, 0.16),
  "editor.wordHighlightTextBackground": resolveColor(palette.warning, 0.12),
  "editor.hoverHighlightBackground": resolveColor(palette.accent, 0.12),
  "editor.findMatchBackground": resolveColor(palette.warning, 0.32),
  "editor.findMatchHighlightBackground": resolveColor(palette.warning, 0.18),
  "editor.findRangeHighlightBackground": resolveColor(palette.accent, 0.1),
  "editorLink.activeForeground": resolveColor(palette.accentStrong),
  "editorInfo.foreground": resolveColor(palette.accent),
  "editorWarning.foreground": resolveColor(palette.warning),
  "editorError.foreground": resolveColor(palette.error),
  "editorHint.foreground": resolveColor(palette.muted),
  "editorLightBulb.foreground": resolveColor(palette.warning),
  "editorLightBulbAutoFix.foreground": resolveColor(palette.success),
  "editorIndentGuide.background1": resolveColor(palette.subtle, 0.45),
  "editorIndentGuide.activeBackground1": resolveColor(palette.muted),
  "editorWhitespace.foreground": resolveColor(palette.subtle, 0.6),
  "editorBracketHighlight.foreground1": resolveColor(palette.punctuation),
  "editorBracketHighlight.foreground2": resolveColor(palette.punctuation),
  "editorBracketHighlight.foreground3": resolveColor(palette.punctuation),
  "editorBracketHighlight.unexpectedBracket.foreground": resolveColor(palette.error),
  "editorBracketMatch.background": resolveColor(palette.accent, 0.16),
  "editorBracketMatch.border": resolveColor(palette.punctuation, 0.7),
  "editorWidget.background": resolveColorReference(palette.surface, resolveColor),
  "editorWidget.foreground": resolveColor(palette.foreground),
  "editorWidget.border": resolveColor(palette.border, 0.55),
  "editorHoverWidget.background": resolveColorReference(palette.surface, resolveColor),
  "editorHoverWidget.foreground": resolveColor(palette.foreground),
  "editorHoverWidget.border": resolveColor(palette.border, 0.55),
  "editorHoverWidget.statusBarBackground": resolveColor(palette.subtle, 0.16),
  "editorSuggestWidget.background": resolveColorReference(palette.surface, resolveColor),
  "editorSuggestWidget.foreground": resolveColor(palette.foreground),
  "editorSuggestWidget.border": resolveColor(palette.border, 0.55),
  "editorSuggestWidget.highlightForeground": resolveColor(palette.accentStrong),
  "editorSuggestWidget.selectedBackground": resolveColor(palette.accent, 0.18),
  "editorSuggestWidget.selectedForeground": resolveColor(palette.foreground),
  "editorSuggestWidget.focusHighlightForeground": resolveColor(palette.accentStrong),
  "input.background": resolveColorReference(palette.surface, resolveColor),
  "input.foreground": resolveColor(palette.foreground),
  "input.border": resolveColor(palette.border, 0.55),
  "input.placeholderForeground": resolveColor(palette.muted),
  "inputOption.activeBorder": resolveColor(palette.accent),
  "inputOption.activeBackground": resolveColor(palette.accent, 0.16),
  "inputOption.activeForeground": resolveColor(palette.foreground),
  "scrollbarSlider.background": resolveColor(palette.muted, 0.18),
  "scrollbarSlider.hoverBackground": resolveColor(palette.muted, 0.3),
  "scrollbarSlider.activeBackground": resolveColor(palette.muted, 0.42),
  "editorOverviewRuler.border": resolveColor(palette.border, 0.3),
  "editorOverviewRuler.infoForeground": resolveColor(palette.accent, 0.65),
  "editorOverviewRuler.warningForeground": resolveColor(palette.warning, 0.65),
  "editorOverviewRuler.errorForeground": resolveColor(palette.error, 0.65),
  "editorStickyScroll.background": resolveColorReference(palette.surface, resolveColor),
  "editorStickyScrollHover.background": resolveColor(palette.accent, 0.1),
  "editorCodeLens.foreground": resolveColor(palette.muted),
  "editorInlayHint.foreground": resolveColor(palette.muted),
  "editorInlayHint.background": resolveColor(palette.subtle, 0.12),
  "minimap.background": resolveColorReference(palette.minimap, resolveColor),
  "minimap.foregroundOpacity": resolveColor(palette.foreground, 0.7),
  "minimap.selectionHighlight": resolveColor(palette.accent, 0.55),
  "minimap.selectionOccurrenceHighlight": resolveColor(palette.accent, 0.35),
  "minimap.findMatchHighlight": resolveColor(palette.warning, 0.75),
  "minimap.infoHighlight": resolveColor(palette.accent, 0.8),
  "minimap.warningHighlight": resolveColor(palette.warning, 0.8),
  "minimap.errorHighlight": resolveColor(palette.error, 0.8),
  "minimapSlider.background": resolveColor(palette.muted, 0.18),
  "minimapSlider.hoverBackground": resolveColor(palette.muted, 0.3),
  "minimapSlider.activeBackground": resolveColor(palette.muted, 0.42),
});
