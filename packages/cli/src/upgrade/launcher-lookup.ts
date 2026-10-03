import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PACKAGE } from './constants';

// Where an aio-proxy launcher or platform-native binary sits on disk, per platform naming.

// Windows launchers are npm's .cmd shim and bun's .exe shim; the extensionless
// name is a POSIX shell script there and cannot be executed directly.
const executableNames = (name: string, platform: NodeJS.Platform): readonly string[] =>
  platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];

const launcherNames = (platform: NodeJS.Platform): readonly string[] =>
  platform === 'win32' ? [...executableNames(PACKAGE, platform), PACKAGE] : [PACKAGE];

/** The spawnable `name` command in `dir`: on win32 only its `.exe` or `.cmd`, never the extensionless shim. */
export const executableIn = (
  dir: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined =>
  executableNames(name, platform)
    .map((file) => join(dir, file))
    .find(existsSync);

export const launcherBeside = (command: string, platform: NodeJS.Platform = process.platform): string | undefined => {
  for (const name of launcherNames(platform)) {
    const candidate = join(dirname(command), name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

export const whichOnPath = (
  pathVar: string | undefined = process.env['PATH'],
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (pathVar === undefined || pathVar === '') return undefined;
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue;
    const found = launcherBeside(join(dir, PACKAGE), platform);
    if (found !== undefined) return found;
  }
  return undefined;
};

export const nativeAt = (
  nodeModules: string,
  platformPkg: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const candidate = join(nodeModules, platformPkg, 'bin', platform === 'win32' ? `${PACKAGE}.exe` : PACKAGE);
  return existsSync(candidate) ? candidate : undefined;
};
