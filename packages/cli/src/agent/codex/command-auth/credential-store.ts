import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { CodexLocation } from '../contracts';
import { durableWrite, ensureManagedRoot, isFsCode, readRegularFile } from '../storage/storage';

const token = z.string().regex(/^aio_agent_(?:at|rt)_v1_[A-Za-z0-9_-]{43}$/u);
const CredentialSchema = z.strictObject({
  format: z.literal(1),
  installationId: z.uuid(),
  endpoint: z.url(),
  revision: z.number().int().nonnegative(),
  accessToken: token.regex(/^aio_agent_at_v1_/u),
  refreshToken: token.regex(/^aio_agent_rt_v1_/u),
  accessExpiresAt: z.number().finite().nonnegative(),
  status: z.enum(['ready', 'refreshing', 'reauthorize']),
  refreshStartedAt: z.number().finite().nonnegative().optional(),
  deliveredBy: z.string().min(1).optional(),
});

export type CredentialState = z.output<typeof CredentialSchema>;

export const credentialPath = (location: CodexLocation): string => join(location.managedRoot, 'codex-credential.json');

export async function readCredential(location: CodexLocation): Promise<CredentialState | undefined> {
  const path = credentialPath(location);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('Refusing symbolic credential file');
    if (!metadata.isFile() || metadata.nlink > 1) throw new Error('Refusing unsafe credential file');
  } catch (error) {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  const file = await readRegularFile(path);
  if (file === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    throw new Error('Invalid Codex credential state');
  }
  const parsed = CredentialSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid Codex credential state');
  return parsed.data;
}

export async function writeCredential(
  location: CodexLocation,
  state: CredentialState,
  expected?: Awaited<ReturnType<typeof readRegularFile>>,
): Promise<void> {
  await ensureManagedRoot(location);
  const snapshot = expected ?? (await readRegularFile(credentialPath(location)));
  await durableWrite(credentialPath(location), `${JSON.stringify(state)}\n`, 0o600, snapshot);
}
