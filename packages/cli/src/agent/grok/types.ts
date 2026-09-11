import type { AgentManagedMarker, AgentRevokeStatus } from '@aio-proxy/types';

export type GrokPath = readonly string[];
export type LeafValue =
  | { readonly present: false }
  | { readonly present: true; readonly value: string; readonly raw: string };
export type OwnedLeaf = {
  readonly path: GrokPath;
  readonly original: LeafValue;
  readonly written: LeafValue;
};
export type FieldChange = { readonly path: GrokPath; readonly before: LeafValue; readonly after: LeafValue };
export type TomlEdit = {
  readonly text: string;
  readonly leaves: readonly OwnedLeaf[];
  readonly createdTables: readonly GrokPath[];
  readonly changes: readonly FieldChange[];
  readonly skipped: readonly string[];
};
export type GrokDeadline = { readonly deadline: number; readonly signal: AbortSignal };
export type GrokPolicySource = { readonly path: string; readonly text: string; readonly kind: 'toml' | 'json' };
export type GrokVisiblePolicy = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources: readonly GrokPolicySource[];
};
export type GrokMarker = AgentManagedMarker & { readonly agent: 'grok' };
export type GrokTransaction = {
  readonly operation: 'configure' | 'remove';
  readonly changes: readonly FieldChange[];
  readonly nextLeaves: readonly OwnedLeaf[];
  readonly nextCreatedTables: readonly GrokPath[];
};
export type GrokOwnership = {
  readonly format: 1;
  readonly agent: 'grok';
  readonly installationId: string;
  readonly endpoint: string;
  readonly status: 'active' | 'removing';
  readonly leaves: readonly OwnedLeaf[];
  readonly createdTables: readonly GrokPath[];
  readonly pending?: GrokTransaction;
  readonly cleanupComplete?: true;
};
export type GrokConfigureInput = {
  readonly root: string;
  readonly endpoint: string;
  readonly executable: string;
  readonly adapterVersion: string;
};
export type GrokDeps = {
  readonly now: () => number;
  readonly randomUUID: () => string;
  readonly policy: (root: string, budget?: GrokDeadline) => Promise<GrokVisiblePolicy>;
  readonly revoke: (endpoint: string, installationId: string) => Promise<AgentRevokeStatus>;
};
export type GrokInspection = {
  readonly integrationKind: 'auth-command';
  readonly integration: 'absent' | 'managed' | 'conflict' | 'newer';
  readonly marker?: GrokMarker;
  readonly configuration: 'current' | 'modified' | 'missing' | 'recovery_required';
  readonly fields: readonly string[];
};
export type GrokContext = {
  readonly marker: GrokMarker;
  readonly root: string;
  readonly budget: GrokDeadline;
  readonly assertOwnership: () => Promise<void>;
  readonly lockOwner: string;
  assertRoutingSafe(): Promise<void>;
  readCredential(): Promise<unknown | undefined>;
  writeCredential(value: unknown): Promise<void>;
  clearCredential(): Promise<void>;
};
