import type { Command } from 'commander';

import { useColor } from '../mode';

const RESET = '\u001B[0m';
const BOLD = '\u001B[1m';

const paint = (color: string, bold = false): ((text: string) => string) => {
  // "ansi" is empty on current Bun; "ansi-16m" is the truecolor sequence.
  const open = Bun.color(color, 'ansi-16m');
  if (open === null) return (text) => text;
  const prefix = bold ? `${open}${BOLD}` : open;
  return (text) => `${prefix}${text}${RESET}`;
};

// Commander measures columns with displayWidth, which already ignores ANSI.
export function applyHelpStyling(program: Command, stdoutIsTTY = process.stdout.isTTY === true): void {
  if (!useColor(stdoutIsTTY, process.env)) return;
  const title = paint('#e8e8e8', true);
  const command = paint('#7aa2f7', true);
  const option = paint('#7dcfff');
  const argument = paint('#bb9af7');
  // Copied onto the Help instance. Passing a Help instance is not a config object.
  program.configureHelp({
    styleTitle: title,
    styleCommandText: command,
    styleSubcommandText: command,
    styleOptionText: option,
    styleArgumentText: argument,
  });
}
