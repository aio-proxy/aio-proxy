import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  type AtomicConfigFile,
  type DiagnosticFactory,
  importOAuthAccount,
  OAuthCredentialImportUnsupportedError,
  type PluginLogSink,
  type PluginRegistry,
  type PluginRepository,
  ProviderAccountAlreadyExistsError,
  recoverPendingAccountOperations,
} from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import { isPlainObject } from 'es-toolkit/predicate';

import { CliExit, EXIT } from '../../exit';
import { createProviderLoginDefaultDeps } from '../provider-login/deps';

export type ProviderImportDeps = {
  readonly config: AtomicConfigFile;
  readonly repository: PluginRepository;
  readonly registry: PluginRegistry;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly recover: typeof recoverPendingAccountOperations;
  readonly importAccount: typeof importOAuthAccount;
  readonly cwd: () => string;
  readonly print: (line: string) => void;
  readonly close?: () => void;
};

type ImportCounts = { imported: number; duplicate: number; skipped: number; failed: number };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function safeReason(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : m['cli.provider.import.reason_unknown']();
}

async function importFiles(pathInput: string | undefined, cwd: () => string): Promise<readonly string[]> {
  const root = resolve(pathInput === undefined ? cwd() : pathInput);
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new CliExit(EXIT.unrecoverable, m['cli.provider.import.error_path_not_found']({ path: root }));
    }
    throw error;
  }
  if (info.isFile()) return [root];
  if (!info.isDirectory()) {
    throw new CliExit(EXIT.unrecoverable, m['cli.provider.import.error_path_kind']({ path: root }));
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => join(root, entry.name));
}

async function createProviderImportDefaultDeps(): Promise<ProviderImportDeps> {
  const deps = await createProviderLoginDefaultDeps();
  return {
    config: deps.config,
    repository: deps.repository,
    registry: deps.registry,
    diagnostics: deps.diagnostics,
    logger: deps.logger,
    recover: recoverPendingAccountOperations,
    importAccount: importOAuthAccount,
    cwd: () => process.cwd(),
    print: deps.print,
    close: deps.close,
  };
}

async function importOneFile(file: string, deps: ProviderImportDeps, counts: ImportCounts): Promise<void> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (error) {
    counts.failed += 1;
    deps.print(m['cli.provider.import.status_failed']({ path: file, reason: safeReason(error) }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    counts.failed += 1;
    deps.print(
      m['cli.provider.import.status_failed']({
        path: file,
        reason: error instanceof SyntaxError ? m['cli.provider.import.reason_invalid_json']() : safeReason(error),
      }),
    );
    return;
  }

  if (!isPlainObject(parsed) || typeof parsed['type'] !== 'string' || parsed['type'].trim() === '') {
    counts.failed += 1;
    deps.print(
      m['cli.provider.import.status_failed']({
        path: file,
        reason: m['cli.provider.import.reason_invalid_type'](),
      }),
    );
    return;
  }

  const type = parsed['type'].trim();
  parsed['type'] = type;

  try {
    const result = await deps.importAccount({
      source: 'cpa',
      type,
      raw: parsed,
      registry: deps.registry,
      repository: deps.repository,
      config: deps.config,
      diagnostics: deps.diagnostics,
      logger: deps.logger,
    });
    counts.imported += 1;
    deps.print(m['cli.provider.import.status_imported']({ path: file, provider: result.providerId }));
  } catch (error) {
    if (error instanceof ProviderAccountAlreadyExistsError) {
      counts.duplicate += 1;
      deps.print(m['cli.provider.import.status_duplicate']({ path: file, provider: error.existingProviderId }));
      return;
    }
    if (error instanceof OAuthCredentialImportUnsupportedError) {
      counts.skipped += 1;
      deps.print(m['cli.provider.import.status_skipped']({ path: file, type: JSON.stringify(error.type) }));
      return;
    }
    counts.failed += 1;
    deps.print(
      m['cli.provider.import.status_failed']({
        path: file,
        reason: m['cli.provider.import.reason_unknown'](),
      }),
    );
  }
}

export async function providerImport(pathInput?: string, injected?: ProviderImportDeps): Promise<void> {
  const files = await importFiles(pathInput, injected?.cwd ?? (() => process.cwd()));
  const deps = injected ?? (await createProviderImportDefaultDeps());
  try {
    await deps.recover(deps.config, deps.repository, { mode: 'cli' });
    const counts: ImportCounts = { imported: 0, duplicate: 0, skipped: 0, failed: 0 };
    for (const file of files) {
      await importOneFile(file, deps, counts);
    }
    deps.print(m['cli.provider.import.summary'](counts));
    if (counts.failed > 0) throw new CliExit(EXIT.unrecoverable, '');
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
