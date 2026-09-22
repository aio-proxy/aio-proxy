/// <reference types="bun" />

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { format } from 'oxfmt';

import formatOptions from '../../../oxfmt.config';
import {
  publicOperations,
  type DocumentedPublicOperation,
  type PublicOperation,
} from '../../../packages/server/src/server/public-operations';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';
import { loadPublicOpenApi } from '../openapi-from-routes';
import { type OpenApiDocument, projectOperation } from '../operation-document';

const locales = ['en', 'zh'] as const;
type Locale = (typeof locales)[number];

type LocaleCatalog = {
  readonly shared: {
    readonly apiTitle: string;
    readonly parameters: string;
    readonly responses: string;
    readonly none: string;
  };
  readonly tags: Readonly<Record<string, string>>;
  readonly operations: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

type GenerationInput = {
  readonly root: string;
  readonly check: boolean;
  readonly operations: readonly PublicOperation[];
  readonly catalogs: Readonly<Record<Locale, LocaleCatalog>>;
  readonly document: OpenApiDocument;
};

type Manifest = { readonly files: readonly string[] };

const manifestPath = 'src/generated/manifest.json';
const authorizedReplacements = new Set([
  'docs/en/api/_meta.json',
  'docs/en/api/chat-completions.mdx',
  'docs/en/api/list-models.mdx',
]);

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const isOwnedPath = (path: string): boolean =>
  /^docs\/(?:en|zh)\/api\/(?:_meta\.json|[a-z0-9]+(?:-[a-z0-9]+)*\.mdx)$/u.test(path) ||
  /^src\/generated\/operations\/(?:en|zh)\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u.test(path);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function localizedMessage(catalog: LocaleCatalog, id: string): string {
  let value: unknown = catalog;
  for (const segment of id.split('.')) {
    if (!isObject(value) || !(segment in value)) throw new Error(`Missing locale message "${id}"`);
    value = value[segment];
  }
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid locale message "${id}"`);
  return value;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compare(left, right))
      .map(([key, item]) => [key, sortedJson(item)]),
  );
}

async function json(path: string, value: unknown): Promise<string> {
  const result = await format(`website/${path}`, `${JSON.stringify(sortedJson(value), undefined, 2)}\n`, formatOptions);
  if (result.errors.length > 0) throw new Error(`Could not format generated JSON "${path}"`);
  return result.code;
}

async function mdx(path: string, source: string): Promise<string> {
  const result = await format(`website/${path}`, source, formatOptions);
  if (result.errors.length > 0) throw new Error(`Could not format generated MDX "${path}"`);
  return result.code;
}

function localizedDescription(catalog: LocaleCatalog, operation: DocumentedPublicOperation): string {
  return [
    localizedMessage(catalog, operation.messages.description),
    operation.messages.note === undefined ? undefined : localizedMessage(catalog, operation.messages.note),
  ]
    .filter((value) => value !== undefined)
    .join('\n\n');
}

function selectedOperation(document: OpenApiDocument, operation: DocumentedPublicOperation): Record<string, unknown> {
  const pathItem = document.paths?.[operation.path];
  const selected = pathItem?.[operation.method];
  if (!isObject(selected)) throw new Error(`Missing projected operation "${operation.operationId}"`);
  return selected;
}

function localizedDocument(
  source: OpenApiDocument,
  operation: DocumentedPublicOperation,
  catalog: LocaleCatalog,
): OpenApiDocument {
  const projected = projectOperation(source, operation.operationId);
  const selected = selectedOperation(projected, operation);

  const tags = Array.isArray(projected.tags)
    ? projected.tags.map((tag) => {
        if (!isObject(tag) || typeof tag['x-tag-id'] !== 'string') return tag;
        const name = catalog.tags[tag['x-tag-id']];
        return name === undefined ? tag : { ...tag, name };
      })
    : projected.tags;

  return {
    ...projected,
    info: { ...projected.info, title: catalog.shared.apiTitle },
    ...(tags === undefined ? {} : { tags }),
    paths: {
      [operation.path]: {
        [operation.method]: {
          ...selected,
          summary: localizedMessage(catalog, operation.messages.title),
          description: localizedDescription(catalog, operation),
          tags: [catalog.tags[operation.tag]],
        },
      },
    },
  } as OpenApiDocument;
}

function compactIndex(document: OpenApiDocument, operation: DocumentedPublicOperation, catalog: LocaleCatalog): string {
  const selected = selectedOperation(document, operation);
  const parameters = new Set<string>();
  if (Array.isArray(selected.parameters)) {
    for (const parameter of selected.parameters) {
      if (isObject(parameter) && typeof parameter.name === 'string') parameters.add(parameter.name);
    }
  }

  const requestBody = selected.requestBody;
  if (isObject(requestBody) && isObject(requestBody.content)) {
    for (const mediaType of Object.values(requestBody.content)) {
      if (!isObject(mediaType) || !isObject(mediaType.schema) || !isObject(mediaType.schema.properties)) continue;
      for (const name of Object.keys(mediaType.schema.properties)) parameters.add(name);
    }
  }

  const responses = new Set<string>();
  if (isObject(selected.responses)) {
    for (const [status, response] of Object.entries(selected.responses)) {
      const contentTypes = isObject(response) && isObject(response.content) ? Object.keys(response.content) : [];
      if (contentTypes.length === 0) responses.add(status);
      else for (const contentType of contentTypes) responses.add(`${status} ${contentType}`);
    }
  }

  const list = (values: ReadonlySet<string>): string => {
    if (values.size === 0) return catalog.shared.none;
    return [...values]
      .sort(compare)
      .map((value) => `\`${value}\``)
      .join(', ');
  };
  return `**${catalog.shared.parameters}:** ${list(parameters)}\n\n**${catalog.shared.responses}:** ${list(responses)}`;
}

function page(
  locale: Locale,
  operation: DocumentedPublicOperation,
  document: OpenApiDocument,
  catalog: LocaleCatalog,
): string {
  const title = localizedMessage(catalog, operation.messages.title);
  const summary = localizedMessage(catalog, operation.messages.description);
  const index = compactIndex(document, operation, catalog);

  return `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(summary)}
pageType: doc-wide
outline: false
---

import { ApiOperation } from '../../../src/components/api-operation';

# ${title}

\`${operation.method.toUpperCase()} ${operation.path}\`

${summary}

${index}

<ApiOperation slug="${operation.slug}" locale="${locale}" />
`;
}

async function previousManifest(root: string): Promise<Manifest> {
  const file = Bun.file(join(root, manifestPath));
  if (!(await file.exists())) return { files: [] };

  let value: unknown;
  try {
    value = await file.json();
  } catch {
    throw new Error('Invalid generated manifest');
  }
  if (!isObject(value) || !Array.isArray(value.files) || !value.files.every((path) => typeof path === 'string')) {
    throw new Error('Invalid generated manifest');
  }
  for (const path of value.files) {
    if (!isOwnedPath(path)) throw new Error(`Unsafe generated manifest path "${path}"`);
  }
  return { files: value.files };
}

async function currentText(root: string, path: string): Promise<string | undefined> {
  const file = Bun.file(join(root, path));
  return (await file.exists()) ? file.text() : undefined;
}

async function assertNoCollisions(
  root: string,
  desired: ReadonlyMap<string, string>,
  previous: ReadonlySet<string>,
): Promise<void> {
  for (const path of desired.keys()) {
    if (path.endsWith('.mdx')) {
      const markdown = Bun.file(join(root, path.slice(0, -1)));
      if (await markdown.exists()) throw new Error(`API route collision at "${path.slice(0, -1)}"`);
    }
    if (previous.has(path) || authorizedReplacements.has(path)) continue;
    if (await Bun.file(join(root, path)).exists()) throw new Error(`Generated file collision at "${path}"`);
  }
}

export async function generateApiReferenceFiles({
  root,
  check,
  operations: sourceOperations,
  catalogs,
  document,
}: GenerationInput): Promise<void> {
  const operations = sourceOperations
    .filter((operation): operation is DocumentedPublicOperation => operation.classification === 'documented')
    .sort((left, right) => left.navOrder - right.navOrder || compare(left.operationId, right.operationId));
  const desired = new Map<string, string>();

  for (const locale of locales) {
    const catalog = catalogs[locale];
    const meta = [];
    for (const operation of operations) {
      const pagePath = `docs/${locale}/api/${operation.slug}.mdx`;
      const operationPath = `src/generated/operations/${locale}/${operation.slug}.json`;
      const operationDocument = localizedDocument(document, operation, catalog);
      desired.set(pagePath, await mdx(pagePath, page(locale, operation, operationDocument, catalog)));
      desired.set(operationPath, await json(operationPath, operationDocument));
      meta.push({ type: 'file', name: operation.slug, label: localizedMessage(catalog, operation.messages.title) });
    }
    const metaPath = `docs/${locale}/api/_meta.json`;
    desired.set(metaPath, await json(metaPath, meta));
  }

  const previous = await previousManifest(root);
  const previousFiles = new Set(previous.files);
  await assertNoCollisions(root, desired, previousFiles);
  const files = [...desired.keys()].sort(compare);
  const manifest = await json(manifestPath, { files });
  const stale = previous.files.filter((path) => !desired.has(path));
  const changed: string[] = [];
  for (const [path, contents] of desired) {
    if ((await currentText(root, path)) !== contents) changed.push(path);
  }
  if ((await currentText(root, manifestPath)) !== manifest) changed.push(manifestPath);
  for (const path of stale) {
    if (await Bun.file(join(root, path)).exists()) changed.push(path);
  }

  if (check) {
    if (changed.length > 0) throw new Error(`API reference is out of date: ${changed.sort(compare).join(', ')}`);
    return;
  }

  for (const [path, contents] of desired) {
    if (!changed.includes(path)) continue;
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await Bun.write(absolutePath, contents);
  }
  for (const path of stale) {
    if (await Bun.file(join(root, path)).exists()) await rm(join(root, path));
  }
  if (changed.includes(manifestPath)) {
    const absolutePath = join(root, manifestPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await Bun.write(absolutePath, manifest);
  }
}

export async function generateApiReference({ check }: { readonly check: boolean }): Promise<void> {
  await generateApiReferenceFiles({
    root: resolve(import.meta.dir, '../..'),
    check,
    operations: publicOperations,
    catalogs: { en, zh },
    document: await loadPublicOpenApi(),
  });
}

if (import.meta.main) await generateApiReference({ check: process.argv.includes('--check') });
