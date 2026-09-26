import { z } from 'zod';

import { AgentInstallationSummarySchema, AgentTargetSchema, type AgentTarget } from '../agent-integration';

export const AgentIntegrationKindSchema = z.enum(['plugin', 'auth-command', 'static-config']);
export type AgentIntegrationKind = z.output<typeof AgentIntegrationKindSchema>;

export type AgentDescriptor = {
  readonly target: AgentTarget;
  readonly integrationKind: AgentIntegrationKind;
  readonly catalog: 'synced' | 'host_managed' | 'not_applicable';
  readonly configureCommand: string;
  readonly removeCommand: string;
  readonly loginCommand?: string;
  readonly platformSupport: 'verified' | 'macos_only_verified';
};

const descriptor = (
  target: AgentTarget,
  integrationKind: AgentIntegrationKind,
  rest: Pick<AgentDescriptor, 'catalog' | 'platformSupport'> & { readonly loginCommand?: string },
): AgentDescriptor => ({
  target,
  integrationKind,
  configureCommand: `aio-proxy agent configure ${target}`,
  removeCommand: `aio-proxy agent remove ${target}`,
  ...rest,
});

/** Display order of the dashboard Agents page. */
export const AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  descriptor('opencode', 'plugin', {
    catalog: 'synced',
    loginCommand: 'opencode auth login --provider aio-proxy',
    platformSupport: 'verified',
  }),
  descriptor('pi', 'plugin', { catalog: 'synced', loginCommand: '/login aio-proxy', platformSupport: 'verified' }),
  descriptor('omp', 'plugin', { catalog: 'synced', loginCommand: '/login aio-proxy', platformSupport: 'verified' }),
  descriptor('codex', 'static-config', { catalog: 'not_applicable', platformSupport: 'verified' }),
  descriptor('grok', 'auth-command', {
    catalog: 'host_managed',
    loginCommand: 'grok login',
    platformSupport: 'macos_only_verified',
  }),
];

export const agentDescriptor = (target: AgentTarget): AgentDescriptor =>
  AGENT_DESCRIPTORS.find((item) => item.target === target) as AgentDescriptor;

export const AgentLocalSetupSchema = z.enum(['available', 'remote_request', 'unavailable']);
export type AgentLocalSetup = z.output<typeof AgentLocalSetupSchema>;

export const AgentLocalStatusSchema = z.enum([
  'not_installed',
  'not_configured',
  'configured',
  'outdated',
  'modified',
  'missing',
  'conflict',
  'recovery_required',
]);
export type AgentLocalStatus = z.output<typeof AgentLocalStatusSchema>;

const CodexAuthModeSchema = z.enum(['keep-chatgpt', 'command']);

export const AgentLocalStateSchema = z.strictObject({
  target: AgentTargetSchema,
  host: z.strictObject({
    detected: z.boolean(),
    version: z.string().optional(),
    support: z.enum(['supported', 'unsupported', 'unknown']),
  }),
  status: AgentLocalStatusSchema,
  configPath: z.string().optional(),
  installationId: z.uuid().optional(),
  adapterVersion: z.string().optional(),
  endpointMatches: z.boolean().optional(),
  codex: z.strictObject({ providerId: z.string().optional(), authMode: CodexAuthModeSchema.optional() }).optional(),
});
export type AgentLocalState = z.output<typeof AgentLocalStateSchema>;

export const AgentsSnapshotSchema = z.strictObject({
  localSetup: AgentLocalSetupSchema,
  deviceAuthorization: z.enum(['available', 'password_required']),
  adapterVersion: z.string(),
  installations: z.array(AgentInstallationSummarySchema),
  local: z.array(AgentLocalStateSchema).optional(),
});
export type AgentsSnapshot = z.output<typeof AgentsSnapshotSchema>;

export const CodexKeySelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('existing'), id: z.string().min(1) }),
]);

export const CodexSetupPlanSchema = z.strictObject({
  configPath: z.string(),
  inspection: z.strictObject({
    status: z.enum(['absent', 'managed', 'modified', 'conflict']),
    providerId: z.string().optional(),
    authMode: CodexAuthModeSchema.optional(),
  }),
  defaultProviderId: z.string(),
  defaultAuthMode: CodexAuthModeSchema,
  occupiedProviderIds: z.array(z.string()),
  keyChoices: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  sessions: z.strictObject({
    groups: z.array(
      z.strictObject({
        providerId: z.string(),
        active: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative(),
      }),
    ),
    blocked: z.number().int().nonnegative(),
  }),
  lastMigrationOperationId: z.uuid().optional(),
  planToken: z.string().min(1),
});
export type CodexSetupPlan = z.output<typeof CodexSetupPlanSchema>;

export const CodexConfigureInputSchema = z.strictObject({
  providerId: z.string().min(1),
  auth: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('keep-chatgpt'), key: CodexKeySelectionSchema }),
    z.strictObject({ mode: z.literal('command') }),
  ]),
  migrateFrom: z.array(z.string().min(1)),
  planToken: z.string().min(1),
});
export type CodexConfigureInput = z.output<typeof CodexConfigureInputSchema>;

export const AgentOperationRequestSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('configure'),
      target: AgentTargetSchema,
      codex: CodexConfigureInputSchema.optional(),
    }),
    z.strictObject({ kind: z.literal('remove'), target: AgentTargetSchema }),
    z.strictObject({ kind: z.literal('restore_migration'), target: z.literal('codex'), operationId: z.uuid() }),
  ])
  .superRefine((request, context) => {
    if (request.kind !== 'configure') return;
    if ((request.target === 'codex') !== (request.codex !== undefined))
      context.addIssue({ code: 'custom', message: 'codex input is required for codex and only codex' });
  });
export type AgentOperationRequest = z.output<typeof AgentOperationRequestSchema>;
export type AgentOperationKind = AgentOperationRequest['kind'];

export const AgentOperationErrorCodeSchema = z.enum([
  'host_missing',
  'path_unavailable',
  'locked',
  'occupied_provider_id',
  'endpoint_changed',
  'authorization_denied',
  'authorization_expired',
  'recovery_required',
  'plan_stale',
  'cancelled',
  'unknown',
]);
export type AgentOperationErrorCode = z.output<typeof AgentOperationErrorCodeSchema>;

export const AgentMigrationOutcomeSchema = z.strictObject({
  status: z.enum(['completed', 'partial', 'blocked', 'declined', 'empty', 'not_requested']),
  migrated: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  conflicts: z.number().int().nonnegative().optional(),
  operationId: z.uuid().optional(),
});

/** Token-free outcome of a dashboard configure, remove, or migration restore. */
export const AgentOperationResultSchema = z.strictObject({
  target: AgentTargetSchema,
  status: z.enum([
    'installed',
    'updated',
    'newer',
    'configured',
    'unchanged',
    'cancelled',
    'removed',
    'partial',
    'absent',
    'blocked',
  ]),
  installationId: z.uuid().optional(),
  configPath: z.string().optional(),
  loginCommand: z.string().optional(),
  revokeStatus: z.enum(['revoked', 'expired', 'missing', 'pending']).optional(),
  skippedFields: z.array(z.string()).optional(),
  retainedFiles: z.array(z.string()).optional(),
  preservedPaths: z.array(z.string()).optional(),
  providerId: z.string().optional(),
  authMode: CodexAuthModeSchema.optional(),
  migration: AgentMigrationOutcomeSchema.optional(),
});
export type AgentOperationResult = z.output<typeof AgentOperationResultSchema>;

const operationBase = {
  operationId: z.uuid(),
  target: AgentTargetSchema,
  kind: z.enum(['configure', 'remove', 'restore_migration']),
};
export const AgentOperationStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...operationBase, status: z.literal('running') }),
  z.strictObject({
    ...operationBase,
    status: z.literal('awaiting_approval'),
    installationId: z.uuid(),
    userCode: z.string(),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({ ...operationBase, status: z.literal('succeeded'), result: AgentOperationResultSchema }),
  z.strictObject({ ...operationBase, status: z.literal('failed'), error: AgentOperationErrorCodeSchema }),
]);
export type AgentOperationState = z.output<typeof AgentOperationStateSchema>;
