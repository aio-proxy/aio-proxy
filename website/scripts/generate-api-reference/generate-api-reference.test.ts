import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { format } from 'oxfmt';

import formatOptions from '../../../oxfmt.config';
import type { DocumentedPublicOperation, PublicOperation } from '../../../packages/server/src/server/public-operations';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';
import type { OpenApiDocument } from '../operation-document';
import { generateApiReferenceFiles } from './generate-api-reference';

const catalogs = {
  en: {
    shared: {
      apiTitle: 'API Reference',
      authentication: 'Use a token.',
      parameters: 'Parameters',
      responses: 'Responses',
      none: 'None',
    },
    tags: { Models: 'Models', OpenAI: 'OpenAI-compatible', Anthropic: 'Anthropic-compatible' },
    operations: {
      listModels: {
        title: 'List models',
        summary: 'Short models summary.',
        description: 'Lists available models.',
        note: 'Public models only.',
      },
      createWidget: { title: 'Create a widget', summary: 'Short widget summary.', description: 'Creates a widget.' },
    },
  },
  zh: {
    shared: {
      apiTitle: 'API 参考',
      authentication: '使用令牌。',
      parameters: '参数',
      responses: '响应',
      none: '无',
    },
    tags: { Models: '模型', OpenAI: 'OpenAI 兼容接口', Anthropic: 'Anthropic 兼容接口' },
    operations: {
      listModels: {
        title: '列出模型',
        summary: '简短模型摘要。',
        description: '列出可用模型。',
        note: '仅包含公开模型。',
      },
      createWidget: { title: '创建小部件', summary: '简短小部件摘要。', description: '创建一个小部件。' },
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
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
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
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, stream: { type: 'boolean' } },
                examples: [{ name: 'demo' }],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': {}, 'text/event-stream': {} },
          },
        },
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
    expect(enPage).toContain("title: 'List models GET /v1/models'");
    expect(enPage).toContain(
      'pageType: doc-wide\noutline: false\napiOperationGenerated: true\n---\n\nimport { ApiOperation }',
    );
    expect(enPage).toContain('# List models `GET /v1/models`');
    expect(enPage).not.toContain('# List models\n\n`GET /v1/models`');
    expect(enPage).toContain("description: 'Short models summary.'");
    expect(enPage).toContain('Short models summary.');
    expect(enPage).not.toContain('Lists available models.');
    expect(enPage).toContain('**Parameters:** `limit`');
    expect(enPage).toContain('**Responses:** `200 application/json`');
    expect(enPage).not.toContain('[POST /v1/widgets](/api/create-widget)');
    expect(enPage).toContain('<ApiOperation slug="list-models" locale="en" />');
    expect(zhPage).toContain('# 列出模型 `GET /v1/models`');
    expect(zhPage).toContain("title: '列出模型 GET /v1/models'");
    expect(zhPage).toContain("description: '简短模型摘要。'");
    expect(zhPage).toContain('简短模型摘要。');
    expect(zhPage).not.toContain('列出可用模型。');
    expect(zhPage).toContain('**参数:** `limit`');
    expect(zhPage).toContain('**响应:** `200 application/json`');
    expect(zhPage).toContain('<ApiOperation slug="list-models" locale="zh" />');

    const widgetPage = await read(root, 'docs/en/api/create-widget.mdx');
    expect(widgetPage).toContain('**Parameters:** `name`, `stream`');
    expect(widgetPage).toContain('**Responses:** `201 application/json`, `201 text/event-stream`');

    expect(JSON.parse(await read(root, 'docs/en/api/_meta.json'))).toEqual([
      { type: 'file', name: 'overview', label: 'Overview' },
      { type: 'section-header', label: 'API Reference' },
      {
        type: 'custom-link',
        label: 'Models',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/list-models', label: 'List models', tag: 'GET' }],
      },
      {
        type: 'custom-link',
        label: 'OpenAI-compatible',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/create-widget', label: 'Create a widget', tag: 'POST' }],
      },
    ]);
    expect(JSON.parse(await read(root, 'docs/zh/api/_meta.json'))).toEqual([
      { type: 'file', name: 'overview', label: '概览' },
      { type: 'section-header', label: 'API 参考' },
      {
        type: 'custom-link',
        label: '模型',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/list-models', label: '列出模型', tag: 'GET' }],
      },
      {
        type: 'custom-link',
        label: 'OpenAI 兼容接口',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/create-widget', label: '创建小部件', tag: 'POST' }],
      },
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

  test('groups operations by localized resource with method badges and stable links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-proxy-api-reference-'));
    const operations = [
      ['createResponse', '/v1/responses', 'responses', 'OpenAI', 0],
      ['createMessage', '/v1/messages', 'messages', 'Anthropic', 1],
      ['createChatCompletion', '/v1/chat/completions', 'chat-completions', 'OpenAI', 2],
      ['listModels', '/v1/models', 'list-models', 'Models', 3],
    ].map(
      ([operationId, path, slug, tag, navOrder]) =>
        ({
          classification: 'documented',
          method: operationId === 'listModels' ? 'get' : 'post',
          path,
          operationId,
          slug,
          tag,
          navOrder,
          messages: {
            title: `operations.${operationId}.title`,
            description: `operations.${operationId}.description`,
          },
          responses: {},
        }) as unknown as DocumentedPublicOperation,
    );
    const paths = Object.fromEntries(
      operations.map((operation) => [
        operation.path,
        {
          [operation.method]: {
            operationId: operation.operationId,
            responses: { '200': { description: 'OK' } },
          },
        },
      ]),
    );

    await generateApiReferenceFiles({
      root,
      check: false,
      operations,
      catalogs: { en, zh },
      document: { openapi: '3.1.0', info: { title: 'Fixture API', version: 'latest' }, paths } as OpenApiDocument,
    });

    expect(JSON.parse(await read(root, 'docs/en/api/_meta.json'))).toEqual([
      { type: 'file', name: 'overview', label: 'Overview' },
      { type: 'section-header', label: 'API Reference' },
      {
        type: 'custom-link',
        label: 'Responses',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/responses', label: 'Create a response', tag: 'POST' }],
      },
      {
        type: 'custom-link',
        label: 'Messages',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/messages', label: 'Create a message', tag: 'POST' }],
      },
      {
        type: 'custom-link',
        label: 'Chat',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/chat-completions', label: 'Create a chat completion', tag: 'POST' }],
      },
      {
        type: 'custom-link',
        label: 'Models',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/list-models', label: 'List models', tag: 'GET' }],
      },
    ]);
    expect(JSON.parse(await read(root, 'docs/zh/api/_meta.json'))).toEqual([
      { type: 'file', name: 'overview', label: '概览' },
      { type: 'section-header', label: 'API 参考' },
      {
        type: 'custom-link',
        label: 'Responses',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/responses', label: '创建响应', tag: 'POST' }],
      },
      {
        type: 'custom-link',
        label: 'Anthropic 消息',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/messages', label: '创建消息', tag: 'POST' }],
      },
      {
        type: 'custom-link',
        label: '聊天补全',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/chat-completions', label: '创建聊天补全', tag: 'POST' }],
      },
      {
        type: 'custom-link',
        label: '模型',
        collapsible: true,
        collapsed: false,
        items: [{ type: 'custom-link', link: '/api/list-models', label: '列出模型', tag: 'GET' }],
      },
    ]);
  });

  test('publishes parsed, raw-forwarded, and converted request semantics in both locales', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-proxy-api-reference-'));
    const operations = [
      ['createChatCompletion', '/v1/chat/completions', 'chat-completions', 'OpenAI'],
      ['createResponse', '/v1/responses', 'responses', 'OpenAI'],
      ['createMessage', '/v1/messages', 'messages', 'Anthropic'],
    ].map(
      ([operationId, path, slug, tag], navOrder) =>
        ({
          classification: 'documented',
          method: 'post',
          path,
          operationId,
          slug,
          tag,
          navOrder,
          messages: {
            title: `operations.${operationId}.title`,
            description: `operations.${operationId}.description`,
          },
          responses: {},
        }) as unknown as DocumentedPublicOperation,
    );
    const paths = Object.fromEntries(
      operations.map((operation) => [
        operation.path,
        {
          post: {
            operationId: operation.operationId,
            responses: { '200': { description: 'OK', content: { 'application/json': {} } } },
          },
        },
      ]),
    );

    await generateApiReferenceFiles({
      root,
      check: false,
      operations,
      catalogs: { en, zh },
      document: { openapi: '3.1.0', info: { title: 'Fixture API', version: 'latest' }, paths } as OpenApiDocument,
    });

    for (const operation of operations) {
      const enDocument = JSON.parse(await read(root, `src/generated/operations/en/${operation.slug}.json`));
      const zhDocument = JSON.parse(await read(root, `src/generated/operations/zh/${operation.slug}.json`));
      const enDescription = enDocument.paths[operation.path].post.description as string;
      const zhDescription = zhDocument.paths[operation.path].post.description as string;
      expect(enDescription).toMatch(/parsed/u);
      expect(enDescription).toMatch(/raw-forwarded/u);
      expect(enDescription).toMatch(/converted/u);
      expect(zhDescription).toMatch(/解析/u);
      expect(zhDescription).toMatch(/原始请求/u);
      expect(zhDescription).toMatch(/转换/u);
    }
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

  test('recovers generated ownership when an ignored manifest is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-proxy-api-reference-'));
    await run(root);
    const guide = "import { ApiOperation } from '../../../src/components/api-operation';\n\n# Keep me\n";
    await Bun.write(join(root, 'docs/en/api/guide.mdx'), guide);
    await rm(join(root, 'src/generated/manifest.json'));

    await run(root, [listModels]);

    expect(await Bun.file(join(root, 'docs/en/api/create-widget.mdx')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'src/generated/operations/zh/create-widget.json')).exists()).toBe(false);
    expect(await read(root, 'docs/en/api/guide.mdx')).toBe(guide);
    expect(JSON.parse(await read(root, 'src/generated/manifest.json')).files).not.toContain(
      'docs/en/api/create-widget.mdx',
    );
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
