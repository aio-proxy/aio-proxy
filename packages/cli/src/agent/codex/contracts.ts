import type { AtomicConfigFile } from '@aio-proxy/core';

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

export type KeyChoice = { readonly id: string; readonly label: string };

export type KeySelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'existing'; readonly id: string }
  | { readonly kind: 'new' };

export type ResolvedCredential = {
  readonly token: string;
  readonly kind: 'placeholder' | 'existing' | 'created';
  readonly label?: string;
  readonly verified: boolean;
};

export type KeySnapshot = {
  readonly choices: readonly KeyChoice[];
  readonly resolve: (selection: KeySelection, providerId: string) => Promise<ResolvedCredential>;
};

export type CredentialDeps = {
  readonly file: AtomicConfigFile;
  readonly endpoint: string;
  readonly loadEnvironment: () => void;
  readonly readEnvironment: () => Readonly<Record<string, string | undefined>>;
  readonly randomKey: () => string;
  readonly reload: () => Promise<void>;
  readonly check: (token: string) => Promise<'ok' | 'offline' | 'unauthorized' | 'invalid_response'>;
};
