import { expect, test } from 'bun:test';

import { CliExit } from '../exit';
import { completionCommand } from './completion';

test('emits a bash completion script naming the run command', () => {
  const lines: string[] = [];
  completionCommand('bash', (line) => lines.push(line));
  const out = lines.join('\n');
  expect(out).toContain('complete -F _aio_proxy aio-proxy aiop');
  expect(out).toContain('run');
});

test('zsh completion registers both command names', () => {
  const lines: string[] = [];
  completionCommand('zsh', (line) => lines.push(line));
  expect(lines.join('\n')).toContain('#compdef aio-proxy aiop');
});

test('fish completion lists subcommands as completions', () => {
  const lines: string[] = [];
  completionCommand('fish', (line) => lines.push(line));
  const out = lines.join('\n');
  expect(out).toContain('complete -c aio-proxy -n __fish_use_subcommand -a run');
  expect(out).toContain('complete -c aiop -n __fish_use_subcommand -a run');
});

test('rejects an unsupported shell with an unrecoverable exit', () => {
  expect(() => completionCommand('powershell')).toThrow(CliExit);
});

test('top-level completion includes the public agent command for bash, zsh, and fish', () => {
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const lines: string[] = [];
    completionCommand(shell, (line) => lines.push(line));
    expect(lines.join('\n')).toContain('agent');
  }
});

test('rejects an inherited Object property as a shell', () => {
  // Regression: `shell in SCRIPTS` walked the prototype chain, so `toString`
  // printed a prototype value and exited 0. An own-property check must reject it.
  expect(() => completionCommand('toString')).toThrow(CliExit);
  expect(() => completionCommand('constructor')).toThrow(CliExit);
});
