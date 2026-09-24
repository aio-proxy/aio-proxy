import { describe, expect, test } from 'bun:test';

import { Command } from 'commander';

import { applyHelpStyling } from './help';

function program(): Command {
  return new Command()
    .name('aiop')
    .description('AIO Proxy')
    .option('--lang <locale>', 'language')
    .command('run')
    .description('start').parent!;
}

describe('applyHelpStyling', () => {
  const previous = process.env['NO_COLOR'];

  test('colors help on a TTY', () => {
    delete process.env['NO_COLOR'];
    const root = program();
    applyHelpStyling(root, true);
    const helper = root.createHelp();
    const esc = String.fromCharCode(0x1b);
    expect(helper.styleTitle('Usage:')).toContain(`${esc}[32m`);
    expect(helper.styleSubcommandText('run')).toContain(`${esc}[1m${esc}[32m`);
    expect(helper.styleOptionText('--lang')).toContain(`${esc}[36m`);
    expect(helper.styleDescriptionText('start')).toContain(`${esc}[2m`);
    expect(helper.styleDescriptionText('start')).not.toContain(`${esc}[3`);
    expect(helper.styleArgumentText('<shell>')).toBe('<shell>');
    expect(helper.styleSubcommandText('run')).toContain('run');
    expect(helper.styleOptionText('--lang')).toContain('--lang');
    // Commander strips color when stdout is not a TTY. The hooks above are what it calls first.
    expect(root.helpInformation()).toContain('Usage: aiop');
  });

  test('leaves help plain without a TTY or with NO_COLOR', () => {
    delete process.env['NO_COLOR'];
    const plain = program();
    applyHelpStyling(plain, false);
    expect(plain.createHelp().styleTitle('Usage:')).toBe('Usage:');

    process.env['NO_COLOR'] = '1';
    const muted = program();
    applyHelpStyling(muted, true);
    expect(muted.createHelp().styleTitle('Usage:')).toBe('Usage:');
    if (previous === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = previous;
  });
});
