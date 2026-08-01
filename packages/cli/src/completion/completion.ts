import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../exit';
import { isSupportedShell, renderCompletion, SUPPORTED_SHELLS } from './scripts';

export function completionCommand(shell: string, print: (line: string) => void = console.log): void {
  if (!isSupportedShell(shell)) {
    throw new CliExit(
      EXIT.unrecoverable,
      m['cli.completion.unsupported_shell']({ shell, shells: SUPPORTED_SHELLS.join(', ') }),
    );
  }
  print(renderCompletion(shell));
}
