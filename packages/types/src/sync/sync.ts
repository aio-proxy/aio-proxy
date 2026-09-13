import { z } from 'zod';

import { DashboardLocalizedTextSchema } from '../dashboard-localized-text';
import { DashboardOAuthFormFieldSchema } from '../dashboard-oauth';

const id = z.string().min(1);
const json = z.json();

export const SyncConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'preview-required',
  'syncing',
  'idle',
  'offline',
  'quota',
  'identity-changed',
  'upgrade-required',
  'error',
]);

export const SyncCredentialStateSchema = z.enum([
  'local',
  'shared',
  'unverified',
  'refresh-deferred',
  'result-uncertain',
  'login-required',
  'detach-pending',
  'independent',
]);

export const ProviderSyncViewSchema = z.strictObject({
  providerId: id,
  objectId: id,
  included: z.boolean(),
  credentialState: SyncCredentialStateSchema,
  pendingReason: z.string().nullable(),
});

export const SyncBackendRefSchema = z.strictObject({
  plugin: id,
  capability: id,
  spaceId: id,
});

export const SyncStatusSchema = z.strictObject({
  state: SyncConnectionStateSchema,
  backend: SyncBackendRefSchema.nullable(),
  providers: z.array(ProviderSyncViewSchema),
  pendingOperations: z.number().int().nonnegative(),
  lastSuccessAt: z.number().int().nonnegative().nullable(),
});

export const SyncBackendViewSchema = z.strictObject({
  plugin: id,
  capability: id,
  displayName: DashboardLocalizedTextSchema,
  form: z.array(DashboardOAuthFormFieldSchema),
});

const connectInput = z.strictObject({
  kind: z.literal('connect'),
  plugin: id,
  capability: id,
  options: json,
});
const joinInput = z.strictObject({ kind: z.literal('join'), providerId: id });
const restoreInput = z.strictObject({ kind: z.literal('restore'), objectId: id, operationId: id });
const overridesInput = z.strictObject({
  kind: z.literal('overrides'),
  objectId: id,
  paths: z.array(z.array(z.string().min(1))),
});
const purgeInput = z.strictObject({
  kind: z.literal('purge'),
  scope: z.enum(['provider', 'plugin']),
  objectId: id,
});

const SyncPreviewKindSchema = z.enum(['connect', 'join', 'restore', 'overrides', 'purge']);

export const SyncPreviewInputSchema = z.discriminatedUnion('kind', [
  connectInput,
  joinInput,
  restoreInput,
  overridesInput,
  purgeInput,
]);

export const SyncPreviewRowSchema = z.strictObject({
  objectId: id,
  logicalKey: id,
  kind: id,
  change: z.enum(['add', 'update', 'delete', 'conflict']),
  local: json.nullable(),
  cloud: json.nullable(),
  secretChange: z.enum(['none', 'added', 'changed', 'removed']),
  dependencies: z.array(id),
  choices: z.array(z.enum(['local', 'cloud', 'restore'])),
  // Only set when two distinct objects claim the same Provider ID. A plain local/cloud conflict on
  // one object is resolvable under its existing ID, so the client must not demand a rename for it.
  requiresProviderId: z.boolean().optional(),
  // Only set on a connect preview, for a row with nothing on the cloud side. Connect's default is
  // that every object stays excluded until it is joined, so omitting such a row from the decisions
  // is how that default is expressed — and the client must therefore not preselect a choice for
  // it, or Apply would publish the whole carried configuration to the new backend unasked.
  optional: z.boolean().optional(),
});

export const SyncPreviewSchema = z.strictObject({
  previewId: id,
  kind: SyncPreviewKindSchema,
  rows: z.array(SyncPreviewRowSchema),
  retainedSharedPlugins: z.array(id),
  expiresAt: z.number().int().nonnegative(),
});

export const SyncApplyDecisionSchema = z.strictObject({
  objectId: id,
  choice: z.enum(['local', 'cloud', 'restore']),
  newProviderId: id.optional(),
});

export const SyncApplyInputSchema = z.strictObject({
  previewId: id,
  decisions: z.array(SyncApplyDecisionSchema),
});

export const SyncRangeInputSchema = z.strictObject({ providerId: id, included: z.literal(false) });
export const SyncDetachInputSchema = z.strictObject({ providerId: id, loginSessionId: id });
export const SyncCancelDetachInputSchema = z.strictObject({ providerId: id });

export const SyncHistoryItemSchema = z.strictObject({
  operationId: id,
  objectId: id,
  writtenAt: z.number().int().nonnegative(),
  current: z.boolean(),
});

export type DashboardLocalizedText = z.output<typeof DashboardLocalizedTextSchema>;
export type SyncConnectionState = z.output<typeof SyncConnectionStateSchema>;
export type ProviderSyncView = z.output<typeof ProviderSyncViewSchema>;
export type SyncStatus = z.output<typeof SyncStatusSchema>;
export type SyncBackendView = z.output<typeof SyncBackendViewSchema>;
export type SyncPreviewInput = z.output<typeof SyncPreviewInputSchema>;
export type SyncPreviewRow = z.output<typeof SyncPreviewRowSchema>;
export type SyncPreview = z.output<typeof SyncPreviewSchema>;
export type SyncApplyInput = z.output<typeof SyncApplyInputSchema>;
export type SyncHistoryItem = z.output<typeof SyncHistoryItemSchema>;
export type SyncRangeInput = z.output<typeof SyncRangeInputSchema>;
export type SyncDetachInput = z.output<typeof SyncDetachInputSchema>;
export type SyncCancelDetachInput = z.output<typeof SyncCancelDetachInputSchema>;

export type SyncControlPlane = {
  readonly backends: () => SyncBackendView[];
  readonly status: () => SyncStatus;
  readonly preview: (input: SyncPreviewInput) => Promise<SyncPreview>;
  readonly apply: (input: SyncApplyInput) => Promise<SyncStatus>;
  readonly setRange: (providerId: string, included: false) => Promise<SyncStatus>;
  readonly detach: (providerId: string, loginSessionId: string) => Promise<SyncStatus>;
  readonly cancelDetach: (providerId: string) => Promise<SyncStatus>;
  readonly history: (objectId: string) => Promise<SyncHistoryItem[]>;
  readonly retry: () => Promise<SyncStatus>;
  readonly disconnect: () => Promise<SyncStatus>;
};
