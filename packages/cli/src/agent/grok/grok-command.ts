import { isAbsolute } from 'node:path';

import { readGrokPolicy } from './policy';
import type { GrokDeadline, GrokVisiblePolicy } from './types';

export function grokAuthCommand(executable: string, installationId: string): string {
  if (!isAbsolute(executable) || executable.includes('\0')) throw new Error('invalid CLI entry');
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  return [executable, 'agent', 'auth', 'grok', '--installation-id', installationId].map(quote).join(' ');
}

export function loadGrokPolicy(root: string, budget?: GrokDeadline): Promise<GrokVisiblePolicy> {
  return readGrokPolicy(root, process.env, budget);
}
