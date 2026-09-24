import type { Command } from 'commander';

import { useColor } from '../mode';

const RESET = '\u001B[0m';
const BOLD = '\u001B[1m';
const DIM = '\u001B[2m';
const GREEN = '\u001B[32m';
const CYAN = '\u001B[36m';

// Standard SGR, not Bun.color: its ansi-16 output is the bright variant.
const paint =
  (open: string): ((text: string) => string) =>
  (text) =>
    `${open}${text}${RESET}`;

// Commander measures columns with displayWidth, which already ignores ANSI.
export function applyHelpStyling(program: Command, stdoutIsTTY = process.stdout.isTTY === true): void {
  if (!useColor(stdoutIsTTY, process.env)) return;
  const heading = paint(`${BOLD}${GREEN}`);
  const command = paint(`${BOLD}${GREEN}`);
  const option = paint(CYAN);
  const muted = paint(DIM);
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
