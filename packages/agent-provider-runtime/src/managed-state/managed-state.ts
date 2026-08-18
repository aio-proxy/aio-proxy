import { open, readFile, rename as nodeRename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentManagedMarkerSchema,
  AgentManagedStateV1Schema,
  type AgentCatalogV1,
  type AgentManagedMarker,
  type AgentManagedStateV1,
  type AgentTarget,
} from '@aio-proxy/types';

import { AgentRuntimeError } from '../oauth-client';

export type ManagedInstallation = {
  readonly rootDir: string;
  readonly markerPath: string;
  readonly statePath: string;
  readonly marker: AgentManagedMarker;
};

export async function readManagedInstallation(
  importMetaUrl: string,
  expectedTarget: AgentTarget,
): Promise<ManagedInstallation> {
  const entryDir = dirname(fileURLToPath(importMetaUrl));
  for (const rootDir of [entryDir, dirname(entryDir)]) {
    const markerPath = join(rootDir, '.aio-proxy-managed.json');
    let body: unknown;
    try {
      body = JSON.parse(await readFile(markerPath, 'utf8'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw new AgentRuntimeError('invalid_response');
    }
    const parsed = AgentManagedMarkerSchema.safeParse(body);
    if (!parsed.success || parsed.data.agent !== expectedTarget) throw new AgentRuntimeError('invalid_response');
    return {
      rootDir,
      markerPath,
      statePath: join(rootDir, '.aio-proxy-state.json'),
      marker: parsed.data,
    };
  }
  throw new AgentRuntimeError('invalid_response');
}

export async function readManagedState(statePath: string): Promise<AgentManagedStateV1 | null> {
  try {
    const parsed = AgentManagedStateV1Schema.safeParse(JSON.parse(await readFile(statePath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function readLastKnownCatalog(
  statePath: string,
  expectedTarget: AgentTarget,
): Promise<AgentCatalogV1 | null> {
  const state = await readManagedState(statePath);
  return state?.lkg?.agent === expectedTarget ? state.lkg : null;
}

export async function writeManagedState(
  statePath: string,
  state: AgentManagedStateV1,
  deps: { readonly rename?: typeof nodeRename } = {},
): Promise<void> {
  const parsed = AgentManagedStateV1Schema.parse(state);
  const parent = dirname(statePath);
  const temporary = join(parent, `.${basename(statePath)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await (deps.rename ?? nodeRename)(temporary, statePath);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
