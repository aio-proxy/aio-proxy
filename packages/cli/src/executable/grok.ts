import { isAbsolute } from 'node:path';

import { resolveInstalledLauncher } from '../upgrade/installed-launcher';
import { resolveAgentExecutable } from './executable';

export async function resolveGrokExecutable(
  which?: (name: string) => string | null,
  execPath?: string,
  realpath?: (path: string) => string,
  exists?: (path: string) => boolean,
): Promise<string> {
  const candidate = resolveAgentExecutable(which, execPath, realpath, exists);
  const launcher = await resolveInstalledLauncher(candidate);
  if (!isAbsolute(launcher)) throw new Error('No stable aio-proxy launcher');
  return launcher;
}
