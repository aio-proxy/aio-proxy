import { codexBaseUrl } from '../../control-plane';
import { readCredential } from '../command-auth';
import type { CodexAuthConfig, CodexSetupContext } from '../contracts';
import { prepareCodexCatalog, validateCodexConfig } from '../managed-config';
import { fetchCodexCatalog } from '../model-catalog';
import type { CodexLease } from '../storage/installation-lock';

export async function prepareSetupConfig(
  context: CodexSetupContext,
  providerId: string,
  auth: CodexAuthConfig,
  lease: CodexLease,
) {
  let token: string;
  if (auth.mode === 'keep-chatgpt') token = auth.token;
  else {
    const credential = await readCredential(context.location);
    if (
      credential?.status !== 'ready' ||
      credential.installationId !== auth.installationId ||
      credential.endpoint !== context.endpoint
    )
      throw new Error('CODEX_AUTH_CREDENTIAL_NOT_READY');
    token = credential.accessToken;
  }
  const catalog = await (context.fetchCatalog ?? fetchCodexCatalog)({
    endpoint: context.endpoint,
    token,
    signal: context.signal,
  });
  const prepared = await prepareCodexCatalog(context.location, catalog, lease);
  const input = {
    location: context.location,
    providerId,
    baseUrl: codexBaseUrl(context.endpoint),
    auth,
    catalogPath: prepared.path,
  };
  // Validation re-reads the durable file and verifies its digest before retiring any command identity.
  await validateCodexConfig(input, lease);
  return input;
}
