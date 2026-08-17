export type TailwindColorVariable = `--color-${string}`;
export type CodeEditorColorMix = {
  readonly from: TailwindColorVariable;
  readonly to: TailwindColorVariable;
  readonly toAmount: number;
};
export type CodeEditorColor = TailwindColorVariable | CodeEditorColorMix;

export type EditorPalette = {
  readonly foreground: CodeEditorColor;
  readonly surface: CodeEditorColor;
  readonly muted: CodeEditorColor;
  readonly subtle: CodeEditorColor;
  readonly accent: CodeEditorColor;
  readonly accentStrong: CodeEditorColor;
  readonly warning: CodeEditorColor;
  readonly error: CodeEditorColor;
  readonly punctuation: CodeEditorColor;
};

const percent = (amount: number) => `${Math.round(amount * 100)}%`;

export const toCssColor = (color: CodeEditorColor, opacity = 1): string => {
  const value =
    typeof color === 'string'
      ? `var(${color})`
      : `color-mix(in oklab, var(${color.to}) ${percent(color.toAmount)}, var(${color.from}))`;
  return opacity === 1 ? value : `color-mix(in oklab, ${value} ${percent(opacity)}, transparent)`;
};
