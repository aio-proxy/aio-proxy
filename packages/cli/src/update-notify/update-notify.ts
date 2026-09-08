import { homedir } from 'node:os';
import { join } from 'node:path';

import { readUpdateCheckState, withUpdateCheckLock, writeUpdateCheckState } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import { isRecord } from '@aio-proxy/shared';

export const shouldPrintUpdateBanner = (command: string, argv: readonly string[]): boolean => {
  if (command === 'upgrade' || command === 'update') return false;
  if (argv.includes('--version') || argv.includes('-v')) return false;
  return true;
};

export const printUpdateBanner = (
  current: string,
  print: (line: string) => void = (line) => {
    console.error(line);
  },
): void => {
  const state = readUpdateCheckState();
  if (state === undefined) return;
  try {
    if (Bun.semver.order(state.latest, current) <= 0) return;
  } catch {
    return;
  }
  print(m['cli.update.available']({ version: state.latest }));
};

export type NotifySpawn = (command: readonly string[]) => Promise<void>;

const defaultSpawn: NotifySpawn = async (command) => {
  const proc = Bun.spawn([...command], { stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) !== 0) throw new Error('Desktop notification command failed');
};

export const notifyUpdateAvailable = async (
  latest: string,
  spawn: NotifySpawn = defaultSpawn,
  notificationPath: string = join(homedir(), '.aio-proxy', 'update-notify.json'),
): Promise<void> => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const title = m['cli.update.notify_title']({ version: latest });
  const body = m['cli.update.notify_body']();
  const command =
    process.platform === 'darwin'
      ? ['osascript', '-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]
      : ['notify-send', title, body];
  let handled = false;
  try {
    // Hold the shared lock through delivery; only successful commands consume
    // the version, so a headless instance cannot suppress a later GUI instance.
    await withUpdateCheckLock(async () => {
      handled = true;
      const previous = readUpdateCheckState(notificationPath);
      if (previous !== undefined && Bun.semver.order(latest, previous.latest) <= 0) return;
      await spawn(command);
      await writeUpdateCheckState({ latest, checkedAt: Date.now() }, notificationPath);
    }, notificationPath);
  } catch (error) {
    // The lock helper rethrows open's EEXIST after waiting for an owner.
    // A busy lock is not unavailable storage; never send outside that lock.
    if (
      isRecord(error) &&
      error['code'] === 'EEXIST' &&
      error['syscall'] === 'open' &&
      error['path'] === `${notificationPath}.lock`
    )
      return;
    // Storage is optional. Do not retry a delivery already attempted, including
    // when persisting its successful result failed.
    if (handled) return;
    try {
      await spawn(command);
    } catch {
      // Missing commands or graphical sessions must not fail the update check.
    }
  }
};
