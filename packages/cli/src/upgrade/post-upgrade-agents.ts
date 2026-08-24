import { isAbsolute, resolve } from 'node:path';

import { AgentTargetSchema, type AgentTarget } from '@aio-proxy/types';
import { z } from 'zod';

import type { AgentLocation } from '../agent/hosts';
import { installManagedIntegration, type LocalIntegrationStatus } from '../agent/managed-installation';
import type { UpgradeTarget } from './constants';

export type AgentPostUpgradePayload = {
  readonly format: 1;
  readonly targets: readonly {
    readonly target: AgentTarget;
    readonly managedDir: string;
    readonly adjacentEntry?: string;
  }[];
};
export type AgentPostUpgradeItemResult =
  | { readonly target: AgentTarget; readonly status: 'updated' | 'absent' | 'newer' }
  | { readonly target: AgentTarget; readonly status: 'warning'; readonly reason: string };
export type AgentPostUpgradeDeps = {
  readonly resolveLocation: (target: AgentTarget) => Promise<AgentLocation>;
  readonly inspect: (location: AgentLocation, now: () => number) => Promise<LocalIntegrationStatus>;
  readonly install: typeof installManagedIntegration;
  readonly readAssets: (target: AgentTarget) => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly adapterVersion: string;
  readonly now: () => number;
};
export type AgentUpgradeHandoffDeps = {
  readonly captureAgentTargets: () => Promise<AgentPostUpgradePayload>;
  readonly isEffectiveUserRoot: () => boolean;
  readonly resolveNewBinary: (target: UpgradeTarget, installedVersion: string) => Promise<string>;
  readonly invokeAgentPostUpgrade: (
    binary: string,
    payload: AgentPostUpgradePayload,
  ) => Promise<readonly AgentPostUpgradeItemResult[]>;
};

const PostUpgradeTargetSchema = z
  .strictObject({
    target: AgentTargetSchema,
    managedDir: z.string().refine(isAbsolute, 'managedDir must be absolute'),
    adjacentEntry: z.string().refine(isAbsolute, 'adjacentEntry must be absolute').optional(),
  })
  .superRefine((row, context) => {
    if ((row.target === 'opencode') !== (row.adjacentEntry !== undefined)) {
      context.addIssue({ code: 'custom', message: 'adjacentEntry is required only for OpenCode' });
    }
  });

export const AgentPostUpgradePayloadSchema: z.ZodType<AgentPostUpgradePayload> = z
  .strictObject({
    format: z.literal(1),
    targets: z.array(PostUpgradeTargetSchema).max(3),
  })
  .superRefine((payload, context) => {
    const seen = new Set<AgentTarget>();
    payload.targets.forEach((row, index) => {
      if (seen.has(row.target)) {
        context.addIssue({ code: 'custom', path: ['targets', index, 'target'], message: 'duplicate target' });
      }
      seen.add(row.target);
    });
  });

const PostUpgradeItemResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ target: AgentTargetSchema, status: z.literal('updated') }),
  z.strictObject({ target: AgentTargetSchema, status: z.literal('absent') }),
  z.strictObject({ target: AgentTargetSchema, status: z.literal('newer') }),
  z.strictObject({
    target: AgentTargetSchema,
    status: z.literal('warning'),
    reason: z.string().trim().min(1),
  }),
]);

export const AgentPostUpgradeItemResultsSchema: z.ZodType<readonly AgentPostUpgradeItemResult[]> = z
  .array(PostUpgradeItemResultSchema)
  .max(3);

const POST_UPGRADE_STDIN_LIMIT = 64 * 1_024;

export async function readAgentPostUpgradePayload(): Promise<AgentPostUpgradePayload> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > POST_UPGRADE_STDIN_LIMIT) {
        await reader.cancel();
        throw new Error('Agent post-upgrade payload exceeds 64 KiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Agent post-upgrade payload is malformed JSON');
  }
  return AgentPostUpgradePayloadSchema.parse(decoded);
}

const resolvedPath = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : resolve(value);

const sameResolvedLocation = (location: AgentLocation, row: AgentPostUpgradePayload['targets'][number]): boolean =>
  resolvedPath(location.managedDir) === resolvedPath(row.managedDir) &&
  resolvedPath(location.adjacentEntry) === resolvedPath(row.adjacentEntry);

const warningReason = (status: LocalIntegrationStatus): string =>
  status.reason === 'entry_invalid' ? 'entry conflict' : 'marker conflict';

const errorReason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runAgentPostUpgrade(
  payload: AgentPostUpgradePayload,
  deps: AgentPostUpgradeDeps,
): Promise<readonly AgentPostUpgradeItemResult[]> {
  const results: AgentPostUpgradeItemResult[] = [];
  for (const row of payload.targets) {
    try {
      const location = await deps.resolveLocation(row.target);
      if (!sameResolvedLocation(location, row)) {
        results.push({ target: row.target, status: 'warning', reason: 'path mismatch' });
        continue;
      }
      const status = await deps.inspect(location, deps.now);
      if (status.integration === 'absent') {
        results.push({ target: row.target, status: 'absent' });
        continue;
      }
      if (status.integration === 'conflict' || status.marker === undefined) {
        results.push({ target: row.target, status: 'warning', reason: warningReason(status) });
        continue;
      }
      const outcome = await deps.install({
        location,
        endpoint: status.marker.endpoint,
        adapterVersion: deps.adapterVersion,
        requestedInstallationId: status.marker.installationId,
        readAssets: () => deps.readAssets(row.target),
        managedOnly: true,
      });
      results.push({ target: row.target, status: outcome === 'newer' ? 'newer' : 'updated' });
    } catch (error) {
      results.push({ target: row.target, status: 'warning', reason: errorReason(error) });
    }
  }
  return results;
}
