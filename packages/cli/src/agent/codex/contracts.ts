import type { ValueSlot } from './config-document';

export type CodexLocation = {
  readonly home: string;
  readonly configPath: string;
  readonly managedRoot: string;
  readonly markerPath: string;
};

export type OwnedField = {
  readonly path: readonly string[];
  readonly before: ValueSlot;
  readonly applied: ValueSlot;
};

export type CodexMarker = {
  readonly format: 1;
  readonly managedBy: 'aio-proxy';
  readonly configPath: string;
  readonly providerId: string;
  readonly fields: readonly OwnedField[];
  readonly createdTables: readonly (readonly string[])[];
};

export type ConfigInspection = {
  readonly status: 'absent' | 'managed' | 'modified' | 'conflict';
  readonly providerId?: string;
  readonly activeProviderId: string;
  readonly baseUrl?: string;
  readonly changedPaths: readonly (readonly string[])[];
};

export type ConfigCommit = { readonly status: 'configured' | 'unchanged'; readonly providerId: string };

export type ConfigRemoval = {
  readonly status: 'removed' | 'partial' | 'absent';
  readonly preservedPaths: readonly (readonly string[])[];
};
