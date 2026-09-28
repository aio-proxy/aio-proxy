import { homedir } from 'node:os';

import { resolveAgentEndpoint } from '../control-plane';

type GateInput = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly resolveEndpoint: () => Promise<string>;
  readonly home: () => string;
};

/**
 * Local one-click setup writes the Agent files of the account running aio-proxy. Containers opt
 * out through the image environment, and a non-loopback endpoint or missing home means those
 * files are not the ones the user's Agents read.
 */
export async function shouldEnableAgentHost(
  input: GateInput = { env: process.env, resolveEndpoint: resolveAgentEndpoint, home: homedir },
): Promise<boolean> {
  if (input.env['AIO_PROXY_AGENT_HOST'] === 'disabled') return false;
  try {
    if (input.home() === '') return false;
    await input.resolveEndpoint();
    return true;
  } catch {
    return false;
  }
}
