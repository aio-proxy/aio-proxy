import type { BeforeMount } from "@monaco-editor/react";

import {
  type CodeEditorColor,
  type CodeEditorColorResolver,
  createEditorColors,
  type EditorPalette,
} from "./theme-colors";
import { getCssVariableHex, getCssVariableMixHex } from "./utils";

type MonacoThemeData = Parameters<Parameters<BeforeMount>[0]["editor"]["defineTheme"]>[1];
type TokenColorRule = readonly [token: string, color: CodeEditorColor];

const LIGHT_JSON_PROPERTY_COLOR = {
  from: "--color-cyan-400",
  to: "--color-neutral-500",
  toAmount: 0.75,
} as const satisfies CodeEditorColor;

const LIGHT_STRING_COLOR = {
  from: "--color-red-500",
  to: "--color-olive-500",
  toAmount: 0.6,
} as const satisfies CodeEditorColor;

const LIGHT_PUNCTUATION_COLOR = {
  from: "--color-neutral-500",
  to: "--color-neutral-400",
  toAmount: 0.61,
} as const satisfies CodeEditorColor;

const DARK_JSON_PROPERTY_COLOR = {
  from: "--color-cyan-700",
  to: "--color-taupe-400",
  toAmount: 0.51,
} as const satisfies CodeEditorColor;

const DARK_STRING_COLOR = {
  from: "--color-red-400",
  to: "--color-taupe-400",
  toAmount: 0.5,
} as const satisfies CodeEditorColor;

const DARK_NUMBER_COLOR = {
  from: "--color-sky-600",
  to: "--color-slate-400",
  toAmount: 0.58,
} as const satisfies CodeEditorColor;

const DARK_KEYWORD_COLOR = {
  from: "--color-teal-600",
  to: "--color-olive-500",
  toAmount: 0.36,
} as const satisfies CodeEditorColor;

const DARK_FUNCTION_COLOR = {
  from: "--color-green-500",
  to: "--color-olive-400",
  toAmount: 0.64,
} as const satisfies CodeEditorColor;

const DARK_PUNCTUATION_COLOR = {
  from: "--color-neutral-500",
  to: "--color-neutral-400",
  toAmount: 0.4,
} as const satisfies CodeEditorColor;

const LIGHT_TOKEN_COLORS = [
  ["", "--color-neutral-700"],
  ["identifier", "--color-yellow-700"],
  ["variable", "--color-yellow-700"],
  ["variable.parameter", "--color-neutral-700"],
  ["variable.predefined", "--color-yellow-700"],
  ["constant", "--color-yellow-700"],
  ["comment", "--color-olive-400"],
  ["number", "--color-sky-700"],
  ["number.hex", "--color-sky-700"],
  ["regexp", "--color-amber-700"],
  ["annotation", "--color-taupe-400"],
  ["type", "--color-cyan-600"],
  ["type.identifier", "--color-cyan-600"],
  ["class", "--color-cyan-600"],
  ["interface", "--color-cyan-600"],
  ["struct", "--color-cyan-600"],
  ["enum", "--color-cyan-600"],
  ["function", "--color-lime-700"],
  ["method", "--color-lime-700"],
  ["property", "--color-yellow-600"],
  ["member", "--color-yellow-600"],
  ["namespace", "--color-mauve-500"],
  ["delimiter", LIGHT_PUNCTUATION_COLOR],
  ["delimiter.html", LIGHT_PUNCTUATION_COLOR],
  ["delimiter.xml", LIGHT_PUNCTUATION_COLOR],
  ["tag", "--color-green-800"],
  ["tag.id.pug", "--color-green-800"],
  ["tag.class.pug", "--color-green-800"],
  ["meta.scss", LIGHT_PUNCTUATION_COLOR],
  ["meta.tag", "--color-yellow-600"],
  ["metatag", "--color-red-800"],
  ["metatag.content.html", LIGHT_STRING_COLOR],
  ["metatag.html", LIGHT_PUNCTUATION_COLOR],
  ["metatag.xml", LIGHT_PUNCTUATION_COLOR],
  ["key", LIGHT_JSON_PROPERTY_COLOR],
  ["string.key.json", LIGHT_JSON_PROPERTY_COLOR],
  ["string.value.json", LIGHT_STRING_COLOR],
  ["attribute.name", "--color-yellow-600"],
  ["attribute.value", LIGHT_STRING_COLOR],
  ["attribute.value.number", "--color-sky-700"],
  ["attribute.value.unit", "--color-sky-700"],
  ["attribute.value.html", LIGHT_STRING_COLOR],
  ["attribute.value.xml", LIGHT_STRING_COLOR],
  ["string", LIGHT_STRING_COLOR],
  ["string.html", LIGHT_STRING_COLOR],
  ["string.sql", LIGHT_STRING_COLOR],
  ["string.yaml", LIGHT_STRING_COLOR],
  ["keyword", "--color-green-800"],
  ["keyword.json", "--color-green-800"],
  ["keyword.flow", "--color-red-800"],
  ["keyword.flow.scss", "--color-red-800"],
  ["operator", "--color-red-800"],
  ["operator.scss", "--color-red-800"],
  ["operator.sql", "--color-red-800"],
  ["operator.swift", "--color-red-800"],
  ["predefined.sql", "--color-green-800"],
  ["invalid", "--color-red-800"],
] as const satisfies readonly TokenColorRule[];

const DARK_TOKEN_COLORS = [
  ["", "--color-taupe-300"],
  ["identifier", "--color-olive-400"],
  ["variable", "--color-olive-400"],
  ["variable.parameter", "--color-taupe-300"],
  ["variable.predefined", "--color-orange-300"],
  ["constant", "--color-orange-300"],
  ["comment", "--color-olive-500"],
  ["number", DARK_NUMBER_COLOR],
  ["number.hex", DARK_NUMBER_COLOR],
  ["regexp", "--color-amber-700"],
  ["annotation", "--color-taupe-400"],
  ["type", "--color-cyan-500"],
  ["type.identifier", "--color-cyan-500"],
  ["class", "--color-cyan-500"],
  ["interface", "--color-cyan-500"],
  ["struct", "--color-cyan-500"],
  ["enum", "--color-cyan-500"],
  ["function", DARK_FUNCTION_COLOR],
  ["method", DARK_FUNCTION_COLOR],
  ["property", DARK_STRING_COLOR],
  ["member", DARK_STRING_COLOR],
  ["namespace", "--color-rose-400"],
  ["delimiter", DARK_PUNCTUATION_COLOR],
  ["delimiter.html", DARK_PUNCTUATION_COLOR],
  ["delimiter.xml", DARK_PUNCTUATION_COLOR],
  ["tag", DARK_KEYWORD_COLOR],
  ["tag.id.pug", DARK_KEYWORD_COLOR],
  ["tag.class.pug", DARK_KEYWORD_COLOR],
  ["meta.scss", DARK_PUNCTUATION_COLOR],
  ["meta.tag", DARK_STRING_COLOR],
  ["metatag", "--color-red-400"],
  ["metatag.content.html", DARK_STRING_COLOR],
  ["metatag.html", DARK_PUNCTUATION_COLOR],
  ["metatag.xml", DARK_PUNCTUATION_COLOR],
  ["key", DARK_JSON_PROPERTY_COLOR],
  ["string.key.json", DARK_JSON_PROPERTY_COLOR],
  ["string.value.json", DARK_STRING_COLOR],
  ["attribute.name", DARK_STRING_COLOR],
  ["attribute.value", DARK_STRING_COLOR],
  ["attribute.value.number.css", DARK_NUMBER_COLOR],
  ["attribute.value.unit.css", DARK_NUMBER_COLOR],
  ["attribute.value.hex.css", "--color-taupe-300"],
  ["string", DARK_STRING_COLOR],
  ["string.sql", DARK_STRING_COLOR],
  ["keyword", DARK_KEYWORD_COLOR],
  ["keyword.json", DARK_KEYWORD_COLOR],
  ["keyword.flow", "--color-red-400"],
  ["keyword.flow.scss", "--color-red-400"],
  ["operator", "--color-red-400"],
  ["operator.scss", "--color-red-400"],
  ["operator.sql", "--color-red-400"],
  ["operator.swift", "--color-red-400"],
  ["predefined.sql", DARK_FUNCTION_COLOR],
  ["invalid", "--color-red-400"],
] as const satisfies readonly TokenColorRule[];

const TOKEN_FONT_STYLES = [
  { token: "emphasis", fontStyle: "italic" },
  { token: "strong", fontStyle: "bold" },
  { token: "metatag.php", fontStyle: "bold" },
] satisfies MonacoThemeData["rules"];

const LIGHT_EDITOR_PALETTE = {
  background: ["--color-olive-50"],
  foreground: "--color-neutral-700",
  surface: ["--color-olive-50"],
  minimap: ["--color-olive-50"],
  muted: "--color-mist-500",
  subtle: "--color-neutral-400",
  border: "--color-neutral-300",
  accent: "--color-sky-700",
  accentStrong: "--color-green-800",
  success: "--color-green-800",
  warning: "--color-amber-700",
  error: "--color-red-800",
  punctuation: LIGHT_PUNCTUATION_COLOR,
} as const satisfies EditorPalette;

const DARK_EDITOR_PALETTE = {
  background: ["--color-neutral-900"],
  foreground: "--color-taupe-300",
  surface: ["--color-neutral-800"],
  minimap: ["--color-neutral-900"],
  muted: "--color-olive-500",
  subtle: "--color-neutral-500",
  border: "--color-neutral-700",
  accent: "--color-teal-600",
  accentStrong: "--color-cyan-500",
  success: "--color-green-600",
  warning: "--color-amber-500",
  error: "--color-red-400",
  punctuation: DARK_PUNCTUATION_COLOR,
} as const satisfies EditorPalette;

const createTokenRules = (rules: readonly TokenColorRule[], resolveColor: CodeEditorColorResolver) => [
  ...rules.map(([token, color]) => ({ token, foreground: resolveColor(color) })),
  ...TOKEN_FONT_STYLES,
];

export const CODE_EDITOR_THEME_IDS = {
  light: "dashboard-light",
  dark: "dashboard-dark",
} as const;

const resolveCodeEditorColor: CodeEditorColorResolver = (color, opacity = 1) =>
  typeof color === "string"
    ? getCssVariableHex(color, opacity)
    : getCssVariableMixHex(color.from, color.to, color.toAmount, opacity);

export const createCodeEditorThemeData = (resolveColor: CodeEditorColorResolver = resolveCodeEditorColor) => {
  const light = {
    base: "vs",
    inherit: false,
    rules: createTokenRules(LIGHT_TOKEN_COLORS, resolveColor),
    colors: createEditorColors(LIGHT_EDITOR_PALETTE, resolveColor),
  } satisfies MonacoThemeData;

  const dark = {
    base: "vs-dark",
    inherit: false,
    rules: createTokenRules(DARK_TOKEN_COLORS, resolveColor),
    colors: createEditorColors(DARK_EDITOR_PALETTE, resolveColor),
  } satisfies MonacoThemeData;

  return { light, dark };
};

export const defineCodeEditorThemes: BeforeMount = (monaco) => {
  const themes = createCodeEditorThemeData();

  monaco.editor.defineTheme(CODE_EDITOR_THEME_IDS.light, themes.light);
  monaco.editor.defineTheme(CODE_EDITOR_THEME_IDS.dark, themes.dark);
};
