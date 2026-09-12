import type { AtomicConfigFile } from '@aio-proxy/core';
import type { AgentDeviceCodeResponse, AgentRevokeStatus } from '@aio-proxy/types';

import type { ValueSlot } from './config-document';

export type CodexLocation = {
  readonly home: string;
  readonly configPath: string;
  readonly managedRoot: string;
  readonly markerPath: string;
  /** Optional verified SQLite root from CODEX_SQLITE_HOME or global config.toml sqlite_home. */
  readonly sqliteHome?: string;
  /** Set only for an explicitly allowed or config-verified legacy JSONL fallback. */
  readonly legacyScanAllowed?: boolean;
};

export type SessionGroup = { readonly providerId: string; readonly active: number; readonly archived: number };

export type MigrationTarget = {
  readonly id: string;
  readonly sourceProviderId: string;
  readonly archived: boolean;
  readonly storage: 'legacy' | 'native';
  readonly revision: string;
};

export type MigrationPreview = {
  readonly groups: readonly SessionGroup[];
  readonly targets: readonly MigrationTarget[];
  readonly blocked: readonly { readonly id: string; readonly reason: string }[];
};

export type MigrationResult = {
  readonly status: 'completed' | 'partial' | 'blocked';
  readonly migrated: number;
  readonly skipped: number;
  readonly conflicts: number;
  readonly operationId?: string;
  readonly recoveryPath?: string;
};

export type OwnedField = {
  readonly path: readonly string[];
  readonly before: ValueSlot;
  readonly applied: ValueSlot;
};

export type CodexAuthMode = 'keep-chatgpt' | 'command';
export type CodexAuthConfig =
  | { readonly mode: 'keep-chatgpt'; readonly token: string }
  | { readonly mode: 'command'; readonly installationId: string; readonly command: string };

export type CodexMarkerV1 = {
  readonly format: 1;
  readonly managedBy: 'aio-proxy';
  readonly configPath: string;
  readonly providerId: string;
  readonly fields: readonly OwnedField[];
  readonly createdTables: readonly (readonly string[])[];
};
export type CodexMarkerV2 =
  | (Omit<CodexMarkerV1, 'format'> & { readonly format: 2; readonly authMode: 'keep-chatgpt' })
  | (Omit<CodexMarkerV1, 'format'> & {
      readonly format: 2;
      readonly authMode: 'command';
      readonly installationId: string;
    });
export type CodexMarker = CodexMarkerV1 | CodexMarkerV2;

export type ConfigInspection = {
  readonly status: 'absent' | 'managed' | 'modified' | 'conflict';
  readonly providerId?: string;
  readonly activeProviderId: string;
  readonly baseUrl?: string;
  readonly authMode?: CodexAuthMode;
  readonly installationId?: string;
  readonly changedPaths: readonly (readonly string[])[];
};

export type ConfigCommit = { readonly status: 'configured' | 'unchanged'; readonly providerId: string };

export type ConfigRemoval = {
  readonly status: 'removed' | 'partial' | 'absent';
  readonly preservedPaths: readonly (readonly string[])[];
};

export type KeyChoice = { readonly id: string; readonly label: string };

export type KeySelection = { readonly kind: 'none' } | { readonly kind: 'existing'; readonly id: string };

export type ResolvedCredential = {
  readonly token: string;
  readonly kind: 'placeholder' | 'existing';
  readonly label?: string;
  readonly verified: boolean;
};

export type KeySnapshot = {
  readonly choices: readonly KeyChoice[];
  readonly resolve: (selection: KeySelection) => Promise<ResolvedCredential>;
};

export type CredentialDeps = {
  readonly file: Pick<AtomicConfigFile, 'read'>;
  readonly loadEnvironment: () => void;
  readonly readEnvironment: () => Readonly<Record<string, string | undefined>>;
  readonly check: (token: string) => Promise<'ok' | 'offline' | 'unauthorized' | 'invalid_response'>;
};

export type CodexSetupSelection = {
  readonly providerId: string;
  readonly auth:
    | { readonly mode: 'keep-chatgpt'; readonly keys: KeySnapshot; readonly selection: KeySelection }
    | { readonly mode: 'command'; readonly command: string };
};

export type CodexSetupCommit = ConfigCommit & {
  readonly authMode: CodexAuthMode;
  readonly credential: 'placeholder' | 'existing' | 'agent';
  readonly connection: 'ok' | 'offline' | 'invalid_response' | 'not_checked';
  readonly installationId?: string;
};

export type CodexSetupContext = {
  readonly location: CodexLocation;
  readonly endpoint: string;
  readonly adapterVersion: string;
  readonly signal: AbortSignal;
  readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void>;
  readonly revoke?: (endpoint: string, installationId: string) => Promise<AgentRevokeStatus>;
};

export type CodexListResult = {
  readonly target: 'codex';
  readonly integration: 'static-config';
  readonly configPath: string;
  readonly providerId?: string;
  readonly activeProviderId: string;
  readonly baseUrl?: string;
  readonly status: ConfigInspection['status'];
  readonly connection: 'ok' | 'offline' | 'unauthorized' | 'invalid_response' | 'not_checked';
  readonly changedPaths: readonly (readonly string[])[];
  readonly authMode?: CodexAuthMode;
  readonly installationId?: string;
  readonly lifecycle?: 'pending' | 'active' | 'retiring';
  readonly authorization?: 'not_checked' | 'active' | 'expired' | 'revoked' | 'missing' | 'pending';
  readonly credentialStatus?: 'missing' | 'ready' | 'expired' | 'reauthorize';
};

export type CodexRemoveResult = {
  readonly target: 'codex';
  readonly integration: 'static-config';
  readonly configPath: string;
  readonly keysRetained: true;
  readonly status: 'removed' | 'partial' | 'absent' | 'blocked';
  readonly preservedPaths: readonly (readonly string[])[];
  readonly authorization?: 'revoked' | 'expired' | 'missing' | 'pending';
};
