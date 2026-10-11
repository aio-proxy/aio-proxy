import { mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { CodexCatalog } from '@aio-proxy/server';
import { isPlainObject } from 'es-toolkit/predicate';

import { readManagedField, type ValueSlot } from '../config-document';
import type { CodexLocation, CodexMarker, OwnedField, PreparedCodexCatalog } from '../contracts';
import type { CodexLease } from '../storage/installation-lock';
import { readJournal } from './journal';
import { readMarker } from './marker';
import {
  assertNoSymlinkParents,
  chmodChecked,
  durableDelete,
  durableWrite,
  ensureManagedRoot,
  inspectDirectory,
  inspectRegularFile,
  readRegularFile,
  syncParent,
} from './storage';

const digestName = /^[a-f0-9]{64}\.json$/u;
const catalogRoot = (location: CodexLocation): string => join(location.managedRoot, 'model-catalogs');
const digestFor = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

export const catalogOwnedField = (marker: CodexMarker): OwnedField | undefined =>
  marker.fields.find((field) => field.path.length === 1 && field.path[0] === 'model_catalog_json');

// A relative or unsupported reference cannot prove that any local digest is unreferenced.
export function catalogReference(slot: ValueSlot | undefined): string | undefined {
  if (slot === undefined || !slot.present) return undefined;
  if (typeof slot.value !== 'string' || !isAbsolute(slot.value) || slot.value.includes('\0'))
    throw new Error('Codex catalog reference cannot be resolved safely');
  return resolve(slot.value);
}

function assertCatalogPath(location: CodexLocation, path: string): string {
  const name = basename(path);
  if (!digestName.test(name) || path !== join(catalogRoot(location), name))
    throw new Error('Codex catalog path must be a managed digest file');
  return name.slice(0, -5);
}

function assertCatalogContents(text: string): void {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed) || !Array.isArray(parsed['models']) || !parsed['models'].every(isPlainObject))
    throw new Error('Codex catalog is invalid');
}

// Codex refuses to start on a catalog without models, so only a non-empty file is worth keeping.
export async function catalogHasModels(path: string): Promise<boolean> {
  const file = await readRegularFile(path);
  if (file === undefined) return false;
  const models: unknown = (JSON.parse(file.text) as { models?: unknown }).models;
  return Array.isArray(models) && models.length > 0;
}

export async function validateCatalogPath(location: CodexLocation, path: string, allowMissing = false): Promise<void> {
  const digest = assertCatalogPath(location, path);
  await assertNoSymlinkParents(dirname(path));
  const file = await readRegularFile(path);
  if (file === undefined) {
    if (allowMissing) return;
    throw new Error('Codex catalog file is missing');
  }
  if (digestFor(file.text) !== digest) throw new Error('Codex catalog digest conflict');
  assertCatalogContents(file.text);
}

export async function prepareCodexCatalog(
  location: CodexLocation,
  catalog: CodexCatalog,
  lease: CodexLease,
): Promise<PreparedCodexCatalog> {
  return lease.withOwnership(async () =>
    lease.withOwnershipFence(async (assertOwned) => {
      const text = `${JSON.stringify(catalog)}\n`;
      assertCatalogContents(text);
      const digest = digestFor(text);
      const root = catalogRoot(location);
      const path = join(root, `${digest}.json`);
      await ensureManagedRoot(location);
      const directory = await inspectDirectory(root);
      if (directory === undefined) {
        await assertOwned();
        await mkdir(root, { mode: 0o700 });
        await syncParent(root);
      }
      await chmodChecked(root, 0o700);
      const existing = await readRegularFile(path);
      if (existing !== undefined) {
        if (existing.text !== text) throw new Error('Codex catalog digest conflict');
        await chmodChecked(path, 0o600);
      } else {
        await assertOwned();
        await durableWrite(path, text, 0o600);
      }
      return { path, digest };
    }),
  );
}

export async function pruneCodexCatalogs(
  location: CodexLocation,
  keep: readonly string[],
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnership(async () =>
    lease.withOwnershipFence(async (assertOwned) => {
      let protectedPaths: Set<string>;
      let candidates: string[];
      let canonicalRoot: string;
      try {
        if ((await readJournal(location)) !== undefined) return;
        const current = await readRegularFile(location.configPath);
        const marker = await readMarker(location);
        protectedPaths = new Set(keep.map((path) => catalogReference({ present: true, value: path })!));
        const actual =
          current === undefined ? undefined : catalogReference(readManagedField(current.text, ['model_catalog_json']));
        const before = marker === undefined ? undefined : catalogReference(catalogOwnedField(marker)?.before);
        if (actual !== undefined) protectedPaths.add(actual);
        if (before !== undefined) protectedPaths.add(before);
        for (const reference of [...protectedPaths]) {
          await assertNoSymlinkParents(dirname(reference));
          if ((await inspectRegularFile(reference)) !== undefined) protectedPaths.add(await realpath(reference));
        }
        if ((await inspectDirectory(catalogRoot(location))) === undefined) return;
        canonicalRoot = await realpath(catalogRoot(location));
        candidates = await readdir(catalogRoot(location));
      } catch {
        // Uncertain ownership must leave the whole catalog set untouched.
        return;
      }
      for (const name of candidates) {
        if (!digestName.test(name)) continue;
        const path = join(catalogRoot(location), name);
        if (protectedPaths.has(path) || protectedPaths.has(join(canonicalRoot, name))) continue;
        let file: Awaited<ReturnType<typeof readRegularFile>>;
        try {
          file = await readRegularFile(path);
          if (file === undefined || digestFor(file.text) !== name.slice(0, -5)) continue;
          assertCatalogContents(file.text);
        } catch {
          // Modified files and symlinks belong to the user; never follow or overwrite them.
          continue;
        }
        await assertOwned();
        await durableDelete(path, file);
      }
    }),
  );
}

export async function pruneRemovedCatalogs(
  location: CodexLocation,
  marker: CodexMarker,
  lease: CodexLease,
): Promise<void> {
  let before: string | undefined;
  try {
    before = catalogReference(catalogOwnedField(marker)?.before);
  } catch {
    return;
  }
  await pruneCodexCatalogs(location, before === undefined ? [] : [before], lease);
}
