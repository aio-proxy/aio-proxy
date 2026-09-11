#!/usr/bin/env bun

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parseRecorderArgv(argv: readonly string[]): { readonly capture: string; readonly command: readonly string[] } {
  if (argv[0] === '--capture' && argv[1] !== undefined && argv[2] === '--' && argv[3] !== undefined) {
    return { capture: argv[1], command: argv.slice(3) };
  }
  throw new Error('usage: helper-recorder --capture <dir> -- <command>...');
}

async function tee(
  stream: ReadableStream<Uint8Array> | undefined,
  file: string,
  dest: NodeJS.WriteStream,
): Promise<void> {
  writeFileSync(file, '');
  if (stream === undefined) return;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    appendFileSync(file, Buffer.from(value));
    dest.write(value);
  }
}

const { capture, command } = parseRecorderArgv(Bun.argv.slice(2));
mkdirSync(capture, { recursive: true, mode: 0o700 });
const child = Bun.spawn([command[0]!, ...command.slice(1)], {
  stdin: 'inherit',
  stdout: 'pipe',
  stderr: 'pipe',
});
const [exitCode] = await Promise.all([
  child.exited,
  tee(child.stdout, join(capture, 'stdout'), process.stdout),
  tee(child.stderr, join(capture, 'stderr'), process.stderr),
]);
writeFileSync(join(capture, 'exitCode'), `${String(exitCode)}\n`);
process.exit(exitCode);
