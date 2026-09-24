import type { Command } from 'commander';

import { useColor } from '../mode';

const RESET = '\u001B[0m';
const BOLD = '\u001B[1m';

const paint = (color: string, bold = false): ((text: string) => string) => {
  // ansi-16 follows the terminal theme. "ansi" is empty on current Bun.
  const open = Bun.color(color, 'ansi-16');
  if (open === null) return (text) => text;
  const prefix = bold ? `${open}${BOLD}` : open;
  return (text) => `${prefix}${text}${RESET}`;
};

// Commander measures columns with displayWidth, which already ignores ANSI.
export function applyHelpStyling(program: Command, stdoutIsTTY = process.stdout.isTTY === true): void {
  if (!useColor(stdoutIsTTY, process.env)) return;
  // Same roles as OpenClaw, on the terminal palette: bold accent headings,
  // a brighter accent for command names, a warning color for flags, muted descriptions.
  const heading = paint('green', true);
  const command = paint('cyan');
  const option = paint('yellow');
  const muted = paint('gray');
  // Copied onto the Help instance. Passing a Help instance is not a config object.
  program.configureHelp({
    styleTitle: heading,
    styleCommandText: command,
    styleSubcommandText: command,
    styleOptionText: option,
    styleDescriptionText: muted,
    styleCommandDescription: muted,
    styleOptionDescription: muted,
    styleSubcommandDescription: muted,
    styleArgumentDescription: muted,
  });
}
