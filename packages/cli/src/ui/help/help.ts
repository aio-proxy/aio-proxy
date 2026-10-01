import { m } from '@aio-proxy/i18n';
import { type Command, Help } from 'commander';

import type { Style } from '../style';

// Commander hard-codes these titles; everything else is a group heading we authored.
const TITLES: Readonly<Record<string, () => string>> = {
  'Usage:': () => m['cli.help.usage'](),
  'Options:': () => m['cli.help.options'](),
  'Commands:': () => m['cli.help.commands'](),
  'Arguments:': () => m['cli.help.arguments'](),
};

// Call after every command is registered: Commander copies help settings into a
// subcommand only when it is created, so this walks the tree itself.
export function applyHelpStyle(program: Command, style: Style): void {
  // `run [options]`, `--lang <locale>`: names strong, placeholders muted.
  const term = (text: string): string =>
    text
      .split(' ')
      .map((word) => (word.startsWith('[') || word.startsWith('<') ? style.muted(word) : style.strong(word)))
      .join(' ');
  const configuration = {
    styleTitle: (title: string) => style.heading(TITLES[title]?.() ?? title.replace(/:$/, '')),
    styleUsage: term,
    styleSubcommandTerm: term,
    styleOptionTerm: term,
    styleArgumentTerm: (text: string) => style.muted(text),
    styleDescriptionText: (text: string) => style.muted(text),
    // The root description moves into the header line.
    commandDescription: (cmd: Command) => (cmd.parent === null ? '' : cmd.description()),
    formatHelp: (cmd: Command, helper: Help) => {
      const body = Help.prototype.formatHelp.call(helper, cmd, helper);
      if (cmd.parent !== null) return body;
      return `${style.strong(cmd.name())} ${style.muted(`${cmd.version() ?? ''} · ${cmd.description()}`)}\n\n${body}`;
    },
  };
  const visit = (cmd: Command): void => {
    cmd.configureHelp(configuration);
    cmd.helpOption('-h, --help', m['cli.help.option_description']());
    if (cmd.commands.length > 0) {
      if (cmd.parent === null) cmd.commandsGroup(m['cli.help.group_setup']());
      cmd.helpCommand('help [command]', m['cli.help.command_description']());
    }
    for (const sub of cmd.commands) visit(sub);
  };
  visit(program);
}
