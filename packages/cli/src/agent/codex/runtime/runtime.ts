import { homedir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigFile, configPath } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import type { AgentDeviceCodeResponse } from '@aio-proxy/types';

import packageJson from '../../../../package.json' with { type: 'json' };
import { readServiceEnvironment } from '../../../service-env';
import { readCodexDocument } from '../config-document';
import type { CodexLocation } from '../contracts';
import { probeProxyApiKey } from '../credentials';
import { resolveCodexLocation } from '../location';
import { inspectCodexConfig } from '../managed-config';
import { isCodexUuid, restoreCodexMigration } from '../sessions';
import type { CodexConfigureResult } from '../wizard';

export const configuredLocation = (): CodexLocation => resolveCodexLocation(join(homedir(), '.codex'), process.env);

export const occupiedIds = async (location: CodexLocation): Promise<readonly string[]> => {
  try {
    const config = await Bun.file(location.configPath).text();
    const ids = readCodexDocument(config).providerIds;
    const managed = (await inspectCodexConfig(location)).providerId;
    return ids.filter((id) => id !== managed);
  } catch {
    return [];
  }
};

export const createCredentialDeps = (endpoint: string) => {
  const path = configPath();
  const file = new AtomicConfigFile(path);
  return {
    file,
    loadEnvironment() {},
    readEnvironment: () => readServiceEnvironment(path),
    check: (token: string) => probeProxyApiKey({ endpoint, token }),
  };
};

export type CodexAuthContextOverrides = {
  readonly onDevice?: (device: AgentDeviceCodeResponse) => Promise<void>;
  readonly signal?: AbortSignal;
};

const AUTH_TIMEOUT_MS = 600_000;

export const authContext = (location: CodexLocation, endpoint: string, overrides: CodexAuthContextOverrides = {}) => ({
  location,
  endpoint,
  adapterVersion: packageJson.version,
  signal:
    overrides.signal === undefined
      ? AbortSignal.timeout(AUTH_TIMEOUT_MS)
      : AbortSignal.any([overrides.signal, AbortSignal.timeout(AUTH_TIMEOUT_MS)]),
  onDevice:
    overrides.onDevice ??
    (async (device: AgentDeviceCodeResponse): Promise<void> => {
      console.error(
        m['cli.agent.codex.device_authorization']({
          url: device.verification_uri_complete,
          code: device.user_code,
        }),
      );
    }),
  revoke: (boundEndpoint: string, installationId: string) =>
    import('../../control-plane').then(({ revokeAgentInstallation }) =>
      revokeAgentInstallation(boundEndpoint, installationId),
    ),
});

export async function restoreMigrationResult(
  location: CodexLocation,
  operationId: string,
): Promise<CodexConfigureResult> {
  if (!isCodexUuid(operationId)) throw new Error('migration operation id must be a UUID');
  const migration = await restoreCodexMigration(location, operationId);
  return {
    target: 'codex',
    integration: 'static-config',
    status: 'unchanged',
    configPath: location.configPath,
    connection: 'not_checked',
    credential: 'none',
    migration,
    migrationAction: 'restore',
  };
}
