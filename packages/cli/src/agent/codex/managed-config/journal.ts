import { open } from 'node:fs/promises';

import { processOwnerIsCurrent, processStarttime } from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { CodexLocation, CodexMarker } from '../contracts';
import { validateMarker } from './marker';
import { durableDelete, durableWrite, ensureManagedRoot, fingerprint, readRegularFile, syncParent } from './storage';

export type JournalOwner = {
  readonly pid: number;
  readonly token: string;
  readonly leaseUntil: number;
  readonly starttime?: string;
};

type JournalBase = {
  readonly originalExists: boolean;
  readonly beforeFingerprint?: string;
  readonly afterFingerprint?: string;
  readonly oldMarker?: CodexMarker;
  readonly stage: 'prepared' | 'config-written' | 'marker-written';
  readonly owner?: JournalOwner;
};

export type ConfigJournal =
  | (JournalBase & { readonly operation: 'configure'; readonly targetMarker: CodexMarker })
  | (JournalBase & { readonly operation: 'remove' });

const invalidJournal = (): Error => new Error('Codex configuration journal is invalid');

const JournalOwnerSchema = z.strictObject({
  pid: z.number().int(),
  token: z.string().min(1),
  leaseUntil: z.number(),
  starttime: z.string().optional(),
});

const journalBaseShape = {
  originalExists: z.boolean(),
  beforeFingerprint: z.string().optional(),
  afterFingerprint: z.string().optional(),
  oldMarker: z.unknown().optional(),
  stage: z.enum(['prepared', 'config-written', 'marker-written']),
  owner: JournalOwnerSchema.optional(),
};

const ConfigJournalSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('configure'),
    ...journalBaseShape,
    targetMarker: z.unknown(),
  }),
  z.strictObject({
    operation: z.literal('remove'),
    ...journalBaseShape,
  }),
]);

function parseConfigJournal(value: unknown, location: CodexLocation): ConfigJournal {
  if (!isPlainObject(value)) throw invalidJournal();
  const parsed = ConfigJournalSchema.safeParse(value);
  if (!parsed.success) throw invalidJournal();
  try {
    const oldMarker = parsed.data.oldMarker === undefined ? undefined : validateMarker(parsed.data.oldMarker, location);
    const base = {
      originalExists: parsed.data.originalExists,
      ...(parsed.data.beforeFingerprint === undefined ? {} : { beforeFingerprint: parsed.data.beforeFingerprint }),
      ...(parsed.data.afterFingerprint === undefined ? {} : { afterFingerprint: parsed.data.afterFingerprint }),
      ...(oldMarker === undefined ? {} : { oldMarker }),
      stage: parsed.data.stage,
      ...(parsed.data.owner === undefined ? {} : { owner: parsed.data.owner }),
    };
    if (parsed.data.operation === 'remove') return { ...base, operation: 'remove' as const };
    return {
      ...base,
      operation: 'configure' as const,
      targetMarker: validateMarker(parsed.data.targetMarker, location),
    };
  } catch {
    throw invalidJournal();
  }
}

const pathFor = (location: CodexLocation): string => `${location.managedRoot}/config-operation.json`;

export async function readJournal(location: CodexLocation): Promise<ConfigJournal | undefined> {
  const current = await readRegularFile(pathFor(location));
  if (current === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(current.text);
  } catch {
    throw invalidJournal();
  }
  return parseConfigJournal(parsed, location);
}

export async function startJournal(location: CodexLocation, journal: ConfigJournal): Promise<ConfigJournal> {
  await ensureManagedRoot(location);
  const path = pathFor(location);
  const starttime = await processStarttime(process.pid);
  const owner: JournalOwner = {
    pid: process.pid,
    token: crypto.randomUUID(),
    leaseUntil: Date.now() + 30_000,
    ...(starttime === null ? {} : { starttime }),
  };
  const record = parseConfigJournal({ ...journal, owner }, location);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  activeOwners.set(owner.token, owner);
  try {
    await syncParent(path);
  } catch (error) {
    activeOwners.delete(owner.token);
    await expireJournalOwner(location, record).catch(() => undefined);
    throw error;
  }
  return record;
}

export async function updateJournal(location: CodexLocation, journal: ConfigJournal): Promise<void> {
  const current = await readRegularFile(pathFor(location));
  if (current === undefined) throw new Error('Codex operation journal disappeared');
  const next = parseConfigJournal(journal, location);
  await durableWrite(pathFor(location), `${JSON.stringify(next)}\n`, 0o600, current);
}

export async function clearJournal(location: CodexLocation): Promise<void> {
  const path = pathFor(location);
  const current = await readJournal(location);
  const file = await readRegularFile(path);
  await durableDelete(path, file);
  if (current?.owner !== undefined) activeOwners.delete(current.owner.token);
}

export async function releaseJournalOwner(location: CodexLocation, journal: ConfigJournal): Promise<void> {
  const owner = journal.owner;
  if (owner === undefined) return;
  activeOwners.delete(owner.token);
  await expireJournalOwner(location, journal);
}

async function expireJournalOwner(location: CodexLocation, journal: ConfigJournal): Promise<void> {
  const current = await readJournal(location);
  if (current === undefined || current.owner?.token !== journal.owner?.token || current.owner === undefined) return;
  await updateJournal(location, { ...current, owner: { ...current.owner, leaseUntil: 0 } });
}

export const journalPath = pathFor;

const activeOwners = new Map<string, JournalOwner>();

export async function isLiveJournal(journal: ConfigJournal | undefined): Promise<boolean> {
  const owner = journal?.owner;
  if (owner === undefined || !Number.isInteger(owner.pid) || typeof owner.token !== 'string') return true;
  if (activeOwners.has(owner.token)) return true;
  if (owner.pid === process.pid) return owner.leaseUntil > Date.now();
  if (owner.leaseUntil > Date.now()) return true;
  return processOwnerIsCurrent(owner);
}

export { fingerprint };
