import { describe, expect, test } from 'bun:test';

import { Command } from 'commander';

import { plainStyle, styleFor } from '../style';
import { applyHelpStyle } from './help';

const ESC = '\u001B';

function build(): Command {
  const program = new Command().name('aio-proxy').description('AIO Proxy').version('1.2.3');
  program.command('run').helpGroup('Server').description('Start');
  const provider = program.command('provider').helpGroup('Providers').description('Providers');
  provider.command('list').description('List providers');
  program.command('doctor').helpGroup('Setup').description('Diagnose');
  return program;
}

describe('applyHelpStyle', () => {
  test('root help leads with name, version and description, then usage', () => {
    const program = build();
    applyHelpStyle(program, plainStyle);
    const text = program.helpInformation();
    expect(text.startsWith('aio-proxy 1.2.3 · AIO Proxy\n\nUsage aio-proxy [options] [command]\n')).toBe(true);
    expect(text.match(/AIO Proxy/g)).toHaveLength(1);
  });

  test('groups commands and files help under Setup', () => {
    const program = build();
    applyHelpStyle(program, plainStyle);
    const text = program.helpInformation();
    const server = text.indexOf('\nServer\n');
    const providers = text.indexOf('\nProviders\n');
    const setup = text.indexOf('\nSetup\n');
    expect(server).toBeGreaterThan(-1);
    expect(providers).toBeGreaterThan(server);
    expect(setup).toBeGreaterThan(providers);
    expect(text.indexOf('help [command]')).toBeGreaterThan(setup);
    expect(text).toContain('Show help for a command');
    expect(text).toContain('Show help');
    expect(text).not.toContain('display help');
    expect(text).not.toContain(':\n');
  });

  test('subcommand help has no version header and no Setup group', () => {
    const program = build();
    applyHelpStyle(program, plainStyle);
    const provider = program.commands.find((command) => command.name() === 'provider')!;
    const text = provider.helpInformation();
    expect(text.startsWith('Usage aio-proxy provider')).toBe(true);
    expect(text).toContain('\nCommands\n');
    expect(text).not.toContain('Setup');
    expect(text).not.toContain('1.2.3');
  });

  test('colors titles as headings, names as strong, placeholders as muted', () => {
    // Commander strips color itself when stdout has none; the test runner's stdout is not a TTY.
    const program = build().configureOutput({ getOutHasColors: () => true });
    applyHelpStyle(program, styleFor('16'));
    const text = program.helpInformation();
    expect(text).toContain(`${ESC}[1m${ESC}[36mServer${ESC}[0m`);
    expect(text).toContain(`${ESC}[1mrun${ESC}[0m`);
    expect(text).toContain(`${ESC}[90m[options]${ESC}[0m`);
  });
});
