import { homedir } from 'node:os';
import { join } from 'node:path';

import { readUpdateCheckState, withUpdateCheckLock, writeUpdateCheckState } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';

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
  try {
    const proc = Bun.spawn([...command], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  } catch {
    // Missing binary or no graphical session must not fail the check.
  }
};

export const notifyUpdateAvailable = async (
  latest: string,
  spawn: NotifySpawn = defaultSpawn,
  notificationPath: string = join(homedir(), '.aio-proxy', 'update-notify.json'),
): Promise<void> => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  // Desktop notifications belong to the OS user, even when instances use
  // different AIO_PROXY_HOME directories. Claim before sending across processes.
  const claimed = await withUpdateCheckLock(async () => {
    const previous = readUpdateCheckState(notificationPath);
    if (previous !== undefined && Bun.semver.order(latest, previous.latest) <= 0) return false;
    await writeUpdateCheckState({ latest, checkedAt: Date.now() }, notificationPath);
    return true;
  }, notificationPath);
  if (!claimed) return;
  const title = m['cli.update.notify_title']({ version: latest });
  const body = m['cli.update.notify_body']();
  if (process.platform === 'darwin') {
    await spawn([
      'osascript',
      '-e',
      `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
    ]);
    return;
  }
  if (process.platform === 'linux') {
    await spawn(['notify-send', title, body]);
  }
};
