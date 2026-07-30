import { expect, test } from 'bun:test';

import { CliExit } from '../exit';
import { completionCommand } from './completion';

test('emits a bash completion script naming the run command', () => {
  const lines: string[] = [];
  completionCommand('bash', (line) => lines.push(line));
  const out = lines.join('\n');
  expect(out).toContain('complete -F _aio_proxy aio-proxy');
  expect(out).toContain('run');
});

test('fish completion lists subcommands as completions', () => {
  const lines: string[] = [];
  completionCommand('fish', (line) => lines.push(line));
  expect(lines.join('\n')).toContain('complete -c aio-proxy -n __fish_use_subcommand -a run');
});

test('rejects an unsupported shell with an unrecoverable exit', () => {
  expect(() => completionCommand('powershell')).toThrow(CliExit);
});
