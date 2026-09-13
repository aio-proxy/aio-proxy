import { resolveInstalledLauncher } from '../upgrade/installed-launcher';
import { resolveAgentExecutable } from './executable';

export async function resolveGrokExecutable(
  which?: (name: string) => string | null,
  execPath?: string,
  realpath?: (path: string) => string,
  exists?: (path: string) => boolean,
): Promise<string> {
  return await resolveInstalledLauncher(resolveAgentExecutable(which, execPath, realpath, exists));
}
