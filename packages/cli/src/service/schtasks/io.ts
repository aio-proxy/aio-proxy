import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';

import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../../exit';
import { processCreationTime, processImagePath, sidForAccount } from '../../win32-ffi';
import { runCapture } from '../run-capture';
import type { UnitOptions } from '../unit-templates';
import { type Capture, currentUser } from './task-query';

type Run = (cmd: readonly string[], allowFailure?: boolean) => Promise<number>;

export type SchtasksIo = {
  /** Mutating schtasks commands; their output is streamed to the user. */
  readonly run: Run;
  /** Queries; their output is parsed, never shown. */
  readonly capture: Capture;
  readonly sid: string;
  /** Resolves an account name to its SID: exported task XML may name the principal by account instead. */
  readonly sidForAccount: (account: string) => string | undefined;
  readonly localAppData: string;
  /** Where the task XML is staged for `/Create /XML`. */
  readonly tempDir: string;
  /** The unit to write: resolved only by the commands that write one. */
  readonly unit: () => Promise<UnitOptions>;
  readonly readFile: (path: string) => string | undefined;
  /** Whether `path` is a regular file: a directory at an exec path is as unrunnable as nothing. */
  readonly exists: (path: string) => boolean;
  readonly writeFile: (path: string, data: string | Uint8Array) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  /** A process's full image path, to tell the supervisor from a later process given its PID. */
  readonly imagePath: (pid: number) => string | undefined;
  /** A process's start time, the other half of that identity: a reused PID starts later. */
  readonly creationTime: (pid: number) => string | undefined;
  /** Terminates a process; on Windows that closes the supervisor's kill-on-close Job Object and ends the proxy too. */
  readonly kill: (pid: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** One line for the user on stderr. */
  readonly warn: (line: string) => void;
};

export function windowsLocalAppData(env: NodeJS.ProcessEnv): string {
  const value = env['LOCALAPPDATA'];
  if (value === undefined || value === '')
    throw new CliExit(EXIT.unrecoverable, m['cli.service.local_app_data_missing']());
  return value;
}

export async function defaultSchtasksIo(
  run: Run,
  unit: () => Promise<UnitOptions>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SchtasksIo> {
  const localAppData = windowsLocalAppData(env);
  const { sid } = await currentUser(runCapture);
  return {
    run,
    capture: runCapture,
    sid,
    sidForAccount,
    localAppData,
    tempDir: tmpdir(),
    unit,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    rename: renameSync,
    remove: (path) => rmSync(path, { force: true }),
    exists: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true,
    imagePath: processImagePath,
    creationTime: processCreationTime,
    kill: (pid) => process.kill(pid),
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    warn: (line) => console.error(line),
  };
}
