import { randomUUID } from 'node:crypto';

import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { CodexLocation } from '../../contracts';
import { durableDelete, durableWrite, ensureManagedRoot, readRegularFile } from '../../storage/storage';

const baseFields = {
  format: z.literal(1),
  operationId: z.uuid(),
  configPath: z.string().min(1),
  providerId: z.string().min(1),
};

const commandPhases = z.enum(['prepared', 'authorized', 'config-written']);
const retirePhases = z.enum(['retiring', 'revoked']);

const schema = z.union([
  z.strictObject({
    ...baseFields,
    kind: z.literal('configure'),
    targetMode: z.literal('command'),
    installationId: z.uuid(),
    phase: commandPhases,
  }),
  z.strictObject({
    ...baseFields,
    kind: z.literal('switch'),
    fromMode: z.enum(['keep-chatgpt', 'command']),
    targetMode: z.literal('command'),
    installationId: z.uuid(),
    phase: commandPhases,
  }),
  z.strictObject({
    ...baseFields,
    kind: z.literal('switch'),
    fromMode: z.enum(['keep-chatgpt', 'command']).optional(),
    targetMode: z.literal('keep-chatgpt'),
    installationId: z.uuid(),
    phase: retirePhases,
  }),
  z.strictObject({
    ...baseFields,
    kind: z.literal('remove'),
    fromMode: z.literal('command'),
    installationId: z.uuid(),
    phase: retirePhases,
  }),
]);

export type AuthOperation = z.infer<typeof schema>;

const invalidOperation = (): Error => new Error('Codex authentication operation is invalid');

const pathFor = (location: CodexLocation): string => `${location.managedRoot}/codex-auth-operation.json`;

export const authOperationPath = pathFor;

function parseAuthOperation(value: unknown, configPath: string): AuthOperation {
  if (!isPlainObject(value)) throw invalidOperation();
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.configPath !== configPath) throw invalidOperation();
  return parsed.data;
}

export async function readAuthOperation(location: CodexLocation): Promise<AuthOperation | undefined> {
  const file = await readRegularFile(pathFor(location));
  if (file === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    throw invalidOperation();
  }
  return parseAuthOperation(value, location.configPath);
}

export async function writeAuthOperation(
  location: CodexLocation,
  operation: Omit<AuthOperation, 'format' | 'operationId'> & Partial<Pick<AuthOperation, 'operationId'>>,
): Promise<AuthOperation> {
  await ensureManagedRoot(location);
  const current = await readRegularFile(pathFor(location));
  const next = parseAuthOperation(
    {
      format: 1,
      operationId: operation.operationId ?? randomUUID(),
      ...operation,
    },
    location.configPath,
  );
  await durableWrite(pathFor(location), `${JSON.stringify(next)}\n`, 0o600, current);
  return next;
}

export async function clearAuthOperation(location: CodexLocation): Promise<void> {
  const current = await readRegularFile(pathFor(location));
  await durableDelete(pathFor(location), current);
}
