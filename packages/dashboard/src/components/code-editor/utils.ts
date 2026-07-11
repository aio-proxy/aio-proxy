import { formatHex8, interpolate, rgb } from "culori";

export const mixHexColors = (from: string, to: string, toAmount: number, opacity = 1): string => {
  const color = rgb(interpolate([from, to], "oklab")(toAmount));

  if (color === undefined) {
    throw new TypeError(`Cannot mix invalid colors ${from} and ${to}`);
  }

  return formatHex8({ ...color, alpha: (color.alpha ?? 1) * opacity });
};

export const getCssVariableHex = (variable: `--${string}`, opacity = 1): string => {
  const color = rgb(getComputedStyle(document.documentElement).getPropertyValue(variable).trim());

  if (color === undefined) {
    throw new TypeError(`CSS variable ${variable} does not contain a valid color`);
  }

  return formatHex8({ ...color, alpha: (color.alpha ?? 1) * opacity });
};

export const getCssVariableMixHex = (from: `--${string}`, to: `--${string}`, toAmount: number, opacity = 1): string =>
  mixHexColors(getCssVariableHex(from), getCssVariableHex(to), toAmount, opacity);
