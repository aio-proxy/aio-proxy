import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentManagedMarkerSchema, AgentManagedStateV1Schema, type AgentManagedMarker } from '@aio-proxy/types';

import type { AgentLocation } from '../hosts';

const STALE_AFTER_MS = 600_000;

export type LocalIntegrationStatus = {
  readonly integration: 'absent' | 'managed' | 'conflict';
  readonly marker?: AgentManagedMarker;
  readonly entry?: 'present' | 'missing';
  readonly catalog: 'fresh' | 'stale' | 'missing';
  readonly lastSuccessfulAt?: string;
  readonly reason?: 'symlink' | 'marker_missing' | 'marker_invalid' | 'entry_invalid';
};

export const openCodeEntry = (installationId: string): string =>
  `// aio-proxy-managed:v1:${installationId}\nexport { default } from "./aio-proxy/index.js";\n`;

const conflict = (reason: NonNullable<LocalIntegrationStatus['reason']>): LocalIntegrationStatus => ({
  integration: 'conflict',
  catalog: 'missing',
  reason,
});

const isEnoent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const inspectPath = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
};

const catalogStatus = (
  now: () => number,
  state: { readonly status: 'fresh' | 'stale' | 'missing'; readonly lastSuccessfulAt: string | null },
): LocalIntegrationStatus['catalog'] => {
  if (
    state.status === 'stale' ||
    (state.lastSuccessfulAt !== null && now() - Date.parse(state.lastSuccessfulAt) > STALE_AFTER_MS)
  ) {
    return 'stale';
  }
  return state.status;
};

const readCatalog = async (
  managedDir: string,
  now: () => number,
): Promise<{ readonly catalog: LocalIntegrationStatus['catalog']; readonly lastSuccessfulAt?: string }> => {
  let raw: string;
  try {
    raw = await readFile(join(managedDir, '.aio-proxy-state.json'), 'utf8');
  } catch (error) {
    if (isEnoent(error)) return { catalog: 'missing' };
    throw error;
  }
  try {
    const parsed = AgentManagedStateV1Schema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { catalog: 'missing' };
    const lastSuccessfulAt = parsed.data.lastSuccessfulAt ?? undefined;
    return lastSuccessfulAt === undefined
      ? { catalog: catalogStatus(now, parsed.data) }
      : { catalog: catalogStatus(now, parsed.data), lastSuccessfulAt };
  } catch {
    return { catalog: 'missing' };
  }
};

export async function inspectManagedInstallation(
  location: AgentLocation,
  now: () => number,
): Promise<LocalIntegrationStatus> {
  const directory = await inspectPath(location.managedDir);
  if (directory === undefined) return { integration: 'absent', catalog: 'missing' };
  if (directory.isSymbolicLink()) return conflict('symlink');
  if (!directory.isDirectory()) return conflict('marker_invalid');

  const markerPath = join(location.managedDir, '.aio-proxy-managed.json');
  const markerStat = await inspectPath(markerPath);
  if (markerStat === undefined) return conflict('marker_missing');
  if (markerStat.isSymbolicLink()) return conflict('symlink');
  if (!markerStat.isFile()) return conflict('marker_invalid');

  let marker: AgentManagedMarker;
  try {
    const parsed = AgentManagedMarkerSchema.safeParse(JSON.parse(await readFile(markerPath, 'utf8')));
    if (!parsed.success || parsed.data.agent !== location.target) return conflict('marker_invalid');
    marker = parsed.data;
  } catch {
    return conflict('marker_invalid');
  }

  let entry: LocalIntegrationStatus['entry'];
  if (location.adjacentEntry !== undefined) {
    const entryStat = await inspectPath(location.adjacentEntry);
    if (entryStat === undefined) {
      entry = 'missing';
    } else if (entryStat.isSymbolicLink()) {
      return conflict('symlink');
    } else if (
      !entryStat.isFile() ||
      !(await readFile(location.adjacentEntry)).equals(Buffer.from(openCodeEntry(marker.installationId)))
    ) {
      return conflict('entry_invalid');
    } else {
      entry = 'present';
    }
  }

  const catalog = await readCatalog(location.managedDir, now);
  return {
    integration: 'managed',
    marker,
    ...(entry === undefined ? {} : { entry }),
    ...catalog,
  };
}
