import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { format } from 'oxfmt';

import formatOptions from '../../../oxfmt.config';
import type { DocumentedPublicOperation, PublicOperation } from '../../../packages/server/src/server/public-operations';
import type { OpenApiDocument } from '../operation-document';
import { generateApiReferenceFiles } from './generate-api-reference';

const catalogs = {
  en: {
    shared: { apiTitle: 'API Reference', authentication: 'Use a token.' },
    tags: { Models: 'Models', OpenAI: 'OpenAI-compatible', Anthropic: 'Anthropic-compatible' },
    operations: {
      listModels: { title: 'List models', description: 'Lists available models.', note: 'Public models only.' },
      createWidget: { title: 'Create a widget', description: 'Creates a widget.' },
    },
  },
  zh: {
    shared: { apiTitle: 'API 参考', authentication: '使用令牌。' },
    tags: { Models: '模型', OpenAI: 'OpenAI 兼容接口', Anthropic: 'Anthropic 兼容接口' },
    operations: {
      listModels: { title: '列出模型', description: '列出可用模型。', note: '仅包含公开模型。' },
      createWidget: { title: '创建小部件', description: '创建一个小部件。' },
    },
  },
} as const;

const listModels = {
  classification: 'documented',
  method: 'get',
  path: '/v1/models',
  operationId: 'listModels',
  slug: 'list-models',
  tag: 'Models',
  navOrder: 0,
  messages: {
    title: 'operations.listModels.title',
    description: 'operations.listModels.description',
    note: 'operations.listModels.note',
  },
  responses: {},
} as unknown as DocumentedPublicOperation;

const createWidget = {
  classification: 'documented',
  method: 'post',
  path: '/v1/widgets',
  operationId: 'createWidget',
  slug: 'create-widget',
  tag: 'OpenAI',
  navOrder: 1,
  messages: {
    title: 'operations.createWidget.title',
    description: 'operations.createWidget.description',
  },
  responses: {},
} as unknown as DocumentedPublicOperation;

const deferred = { classification: 'deferred', method: 'get', path: '/internal' } as const;

const document = {
  openapi: '3.1.0',
  info: { title: 'Fixture API', version: 'latest' },
  tags: [
    { name: 'Models', 'x-tag-id': 'Models' },
    { name: 'OpenAI-compatible', 'x-tag-id': 'OpenAI' },
  ],
  paths: {
    '/v1/models': {
      get: {
        operationId: 'listModels',
        summary: 'List models',
        description: 'English source text.',
        tags: ['Models'],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['data'], properties: { data: { type: 'array' } } },
                example: { data: [] },
              },
            },
          },
        },
      },
    },
    '/v1/widgets': {
      post: {
        operationId: 'createWidget',
        summary: 'Create widget',
        description: 'English source text.',
        tags: ['OpenAI-compatible'],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', examples: [{ name: 'demo' }] },
            },
          },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
  },
} as unknown as OpenApiDocument;

const read = (root: string, path: string) => Bun.file(join(root, path)).text();

const run = (
  root: string,
  operations: readonly PublicOperation[] = [createWidget, deferred, listModels],
  check = false,
) => generateApiReferenceFiles({ root, check, operations, catalogs, document });

describe('generateApiReferenceFiles', () => {
  test('writes deterministic localized pages, metadata, operation documents, and a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-proxy-api-reference-'));
    await mkdir(join(root, 'docs/en/api'), { recursive: true });
    await Bun.write(join(root, 'docs/en/api/list-models.mdx'), 'authorized spike\n');
    await Bun.write(join(root, 'docs/en/api/chat-completions.mdx'), 'authorized spike\n');
    await Bun.write(join(root, 'docs/en/api/_meta.json'), '[]\n');

    await run(root);

    const enPage = await read(root, 'docs/en/api/list-models.mdx');
    const zhPage = await read(root, 'docs/zh/api/list-models.mdx');
    expect(enPage).toStartWith('---\n');
    expect(enPage).toContain('pageType: doc-wide\noutline: false\n---\n\nimport { ApiOperation }');
    expect(enPage).toContain('# List models');
    expect(enPage).toContain('`GET /v1/models`');
    expect(enPage).toContain('Lists available models.');
    expect(enPage).toContain('[GET /v1/models](/api/list-models)');
    expect(enPage).toContain('[POST /v1/widgets](/api/create-widget)');
    expect(enPage).toContain('<ApiOperation slug="list-models" locale="en" />');
    expect(zhPage).toContain('# 列出模型');
    expect(zhPage).toContain('[GET /v1/models](/zh/api/list-models)');
    expect(zhPage).toContain('<ApiOperation slug="list-models" locale="zh" />');

    expect(JSON.parse(await read(root, 'docs/en/api/_meta.json'))).toEqual([
      { type: 'file', name: 'list-models', label: 'List models' },
      { type: 'file', name: 'create-widget', label: 'Create a widget' },
    ]);
    expect(JSON.parse(await read(root, 'docs/zh/api/_meta.json'))).toEqual([
      { type: 'file', name: 'list-models', label: '列出模型' },
      { type: 'file', name: 'create-widget', label: '创建小部件' },
    ]);

    const enDocument = JSON.parse(await read(root, 'src/generated/operations/en/list-models.json'));
    const zhDocument = JSON.parse(await read(root, 'src/generated/operations/zh/list-models.json'));
    expect(enDocument.paths['/v1/models'].get.summary).toBe('List models');
    expect(zhDocument.info.title).toBe('API 参考');
    expect(zhDocument.paths['/v1/models'].get.summary).toBe('列出模型');
    expect(zhDocument.paths['/v1/models'].get.description).toBe('列出可用模型。\n\n仅包含公开模型。');
    expect(zhDocument.paths['/v1/models'].get.responses).toEqual(enDocument.paths['/v1/models'].get.responses);

    const manifest = JSON.parse(await read(root, 'src/generated/manifest.json'));
    expect(manifest.files).toEqual([
      'docs/en/api/_meta.json',
      'docs/en/api/create-widget.mdx',
      'docs/en/api/list-models.mdx',
      'docs/zh/api/_meta.json',
      'docs/zh/api/create-widget.mdx',
      'docs/zh/api/list-models.mdx',
      'src/generated/operations/en/create-widget.json',
      'src/generated/operations/en/list-models.json',
      'src/generated/operations/zh/create-widget.json',
      'src/generated/operations/zh/list-models.json',
    ]);

    for (const path of [
      ...manifest.files.filter((path: string) => path.endsWith('.json')),
      'src/generated/manifest.json',
    ]) {
      const source = await read(root, path);
      expect((await format(`website/${path}`, source, formatOptions)).code).toBe(source);
    }

    const before = await stat(join(root, 'src/generated/manifest.json'));
    await Bun.sleep(20);
    await run(root);
    const after = await stat(join(root, 'src/generated/manifest.json'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test('removes only stale manifest-owned outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-proxy-api-reference-'));
    await run(root);
    await Bun.write(join(root, 'docs/en/api/guide.mdx'), '# Keep me\n');

    await run(root, [listModels]);

    expect(await Bun.file(join(root, 'docs/en/api/create-widget.mdx')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'src/generated/operations/zh/create-widget.json')).exists()).toBe(false);
    expect(await read(root, 'docs/en/api/guide.mdx')).toBe('# Keep me\n');
  });

  test('check mode reports drift without changing or deleting files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-proxy-api-reference-'));
    await run(root);
    const changedPath = 'src/generated/operations/en/list-models.json';
    await Bun.write(join(root, changedPath), 'hand edited\n');

    await expect(run(root, [listModels], true)).rejects.toThrow('API reference is out of date');

    expect(await read(root, changedPath)).toBe('hand edited\n');
    expect(await Bun.file(join(root, 'docs/en/api/create-widget.mdx')).exists()).toBe(true);
  });

  test('rejects unsafe manifests and handwritten route collisions before cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-proxy-api-reference-'));
    await mkdir(join(root, 'src/generated'), { recursive: true });
    const outside = join(root, 'keep.md');
    await Bun.write(outside, 'keep\n');
    await Bun.write(join(root, 'src/generated/manifest.json'), '{"files":["../keep.md"]}\n');

    await expect(run(root)).rejects.toThrow('Unsafe generated manifest path');
    expect(await Bun.file(outside).text()).toBe('keep\n');

    await Bun.write(join(root, 'src/generated/manifest.json'), '{"files":[]}\n');
    await mkdir(join(root, 'docs/en/api'), { recursive: true });
    await Bun.write(join(root, 'docs/en/api/list-models.md'), '# Handwritten\n');
    await expect(run(root)).rejects.toThrow('API route collision');
    expect(await read(root, 'docs/en/api/list-models.md')).toBe('# Handwritten\n');
  });
});
