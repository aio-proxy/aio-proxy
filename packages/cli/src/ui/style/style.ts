import { useColor } from '../mode';

export type ColorDepth = 'none' | '16' | '256' | 'truecolor';
export type Role = 'heading' | 'strong' | 'muted' | 'success' | 'warning' | 'danger';
export type Mark = 'ok' | 'warn' | 'fail' | 'off' | 'hint';
export type Style = Readonly<Record<Role, (text: string) => string>> & { readonly mark: (kind: Mark) => string };

// Dashboard design tokens from packages/ui/src/styles.css, as sRGB hex. The CLI cannot import CSS,
// so these are kept in sync by hand. teal-600 and red-500 pass contrast on light and dark backgrounds.
const TEAL_600 = '#009689';
const OLIVE_500 = '#7c7c67';
const AMBER_600 = '#e17100';
const RED_500 = '#fb2c36';

// Hand-picked 16-color fallback: Bun.color(..., 'ansi-16') maps amber to bright red,
// which would make a warning read as a failure.
const COLORS: Readonly<Record<Exclude<Role, 'strong'>, { readonly hex: string; readonly ansi16: number }>> = {
  heading: { hex: TEAL_600, ansi16: 36 },
  success: { hex: TEAL_600, ansi16: 36 },
  muted: { hex: OLIVE_500, ansi16: 90 },
  warning: { hex: AMBER_600, ansi16: 33 },
  danger: { hex: RED_500, ansi16: 31 },
};

const GLYPHS: Readonly<Record<Mark, readonly [string, Role]>> = {
  ok: ['●', 'success'],
  warn: ['▲', 'warning'],
  fail: ['✗', 'danger'],
  off: ['○', 'muted'],
  hint: ['→', 'muted'],
};

const BOLD = '\u001B[1m';
const RESET = '\u001B[0m';

export function colorDepth(isTTY: boolean, env: NodeJS.ProcessEnv): ColorDepth {
  if (!useColor(isTTY, env)) return 'none';
  const colorterm = env['COLORTERM'];
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  if (env['TERM']?.includes('256color') === true) return '256';
  return '16';
}

function foreground(hex: string, ansi16: number, depth: Exclude<ColorDepth, 'none'>): string {
  const sixteen = `\u001B[${ansi16}m`;
  if (depth === '16') return sixteen;
  return Bun.color(hex, depth === 'truecolor' ? 'ansi-16m' : 'ansi-256') ?? sixteen;
}

export function styleFor(depth: ColorDepth): Style {
  const paint = (role: Role): ((text: string) => string) => {
    if (depth === 'none') return (text) => text;
    if (role === 'strong') return (text) => `${BOLD}${text}${RESET}`;
    const { hex, ansi16 } = COLORS[role];
    const open = `${role === 'heading' ? BOLD : ''}${foreground(hex, ansi16, depth)}`;
    return (text) => `${open}${text}${RESET}`;
  };
  const roles: Readonly<Record<Role, (text: string) => string>> = {
    heading: paint('heading'),
    strong: paint('strong'),
    muted: paint('muted'),
    success: paint('success'),
    warning: paint('warning'),
    danger: paint('danger'),
  };
  return {
    ...roles,
    mark: (kind) => {
      const [glyph, role] = GLYPHS[kind];
      return roles[role](glyph);
    },
  };
}

export function createStyle(stream: { readonly isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): Style {
  return styleFor(colorDepth(stream.isTTY === true, env));
}

export const plainStyle: Style = styleFor('none');
