import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { CodexAuthMode, CodexLocation } from '../contracts';
import { durableDelete, durableWrite, ensureManagedRoot, readRegularFile } from '../storage/storage';

export type AuthOperation = {
  readonly format: 1;
  readonly operationId: string;
  readonly configPath: string;
  readonly kind: 'configure' | 'switch' | 'remove';
  readonly fromMode?: CodexAuthMode;
  readonly targetMode?: CodexAuthMode;
  readonly phase: 'prepared' | 'authorized' | 'retiring' | 'revoked' | 'config-written';
  readonly installationId?: string;
  readonly providerId: string;
};

const schema = z.strictObject({
  format: z.literal(1),
  operationId: z.uuid(),
  configPath: z.string().min(1),
  kind: z.enum(['configure', 'switch', 'remove']),
  fromMode: z.enum(['keep-chatgpt', 'command']).optional(),
  targetMode: z.enum(['keep-chatgpt', 'command']).optional(),
  phase: z.enum(['prepared', 'authorized', 'retiring', 'revoked', 'config-written']),
  installationId: z.uuid().optional(),
  providerId: z.string().min(1),
});

const pathFor = (location: CodexLocation): string => `${location.managedRoot}/codex-auth-operation.json`;

export const authOperationPath = pathFor;

export async function readAuthOperation(location: CodexLocation): Promise<AuthOperation | undefined> {
  const file = await readRegularFile(pathFor(location));
  if (file === undefined) return undefined;
  const parsed = schema.safeParse(JSON.parse(file.text));
  if (!parsed.success || parsed.data.configPath !== location.configPath)
    throw new Error('Codex authentication operation is invalid');
  return parsed.data;
}

export async function writeAuthOperation(
  location: CodexLocation,
  operation: Omit<AuthOperation, 'format' | 'operationId'> & Partial<Pick<AuthOperation, 'operationId'>>,
): Promise<AuthOperation> {
  await ensureManagedRoot(location);
  const current = await readRegularFile(pathFor(location));
  const next: AuthOperation = {
    format: 1,
    operationId: operation.operationId ?? randomUUID(),
    ...operation,
  };
  schema.parse(next);
  await durableWrite(pathFor(location), `${JSON.stringify(next)}\n`, 0o600, current);
  return next;
}

export async function clearAuthOperation(location: CodexLocation): Promise<void> {
  const current = await readRegularFile(pathFor(location));
  await durableDelete(pathFor(location), current);
}
