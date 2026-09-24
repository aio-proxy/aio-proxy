import type { Command } from 'commander';

import { useColor } from '../mode';

const RESET = '\u001B[0m';
const BOLD = '\u001B[1m';

const paint = (color: string, bold = false): ((text: string) => string) => {
  // ansi-16 is the terminal palette (theme-aware). "ansi" is empty on current Bun,
  // and ansi-16m would bake in a fixed RGB.
  const open = Bun.color(color, 'ansi-16');
  if (open === null) return (text) => text;
  const prefix = bold ? `${open}${BOLD}` : open;
  return (text) => `${prefix}${text}${RESET}`;
};

// Commander measures columns with displayWidth, which already ignores ANSI.
export function applyHelpStyling(program: Command, stdoutIsTTY = process.stdout.isTTY === true): void {
  if (!useColor(stdoutIsTTY, process.env)) return;
  // Brand primary is teal. The 16-color palette has no teal, so commands use green.
  const title = paint('white', true);
  const command = paint('green', true);
  const option = paint('cyan');
  const argument = paint('green');
  // Copied onto the Help instance. Passing a Help instance is not a config object.
  program.configureHelp({
    styleTitle: title,
    styleCommandText: command,
    styleSubcommandText: command,
    styleOptionText: option,
    styleArgumentText: argument,
  });
}
