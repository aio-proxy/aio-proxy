import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

const MODALITIES = ['language', 'image', 'embedding', 'speech', 'transcription', 'reranking'] as const;

// Rows persisted before the metadata→extra rename keep the old key. Static
// catalogs never refresh and TTL catalogs serve stale rows until a refresh
// succeeds, so the rename must happen at read time or protocol hints vanish.
// Key-rename ONLY, over UNVALIDATED database JSON: anything that is not a
// plain object — the catalog itself, or a null/primitive descriptor inside a
// modality array — passes through untouched so validateModelCatalog still
// rejects it (`'metadata' in x` throws on primitives; never reach it unguarded).
export function migrateStoredCatalogShape(catalog: ModelCatalog): ModelCatalog {
  if (!isPlainObject(catalog)) return catalog;
  const migrated: Record<string, unknown> = { ...catalog };
  if ('metadata' in migrated) {
    const legacy = migrated['metadata'];
    delete migrated['metadata'];
    if (catalog.extra === undefined) migrated['extra'] = legacy;
  }
  for (const modality of MODALITIES) {
    const list = catalog[modality];
    if (Array.isArray(list)) migrated[modality] = list.map(migrateDescriptor);
  }
  return migrated as ModelCatalog;
}

function migrateDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
  if (!isPlainObject(descriptor)) return descriptor;
  const legacy = descriptor as ModelDescriptor & { readonly metadata?: unknown };
  if (!('metadata' in legacy)) return descriptor;
  const { metadata, ...rest } = legacy;
  return descriptor.extra === undefined ? ({ ...rest, extra: metadata } as ModelDescriptor) : (rest as ModelDescriptor);
}
