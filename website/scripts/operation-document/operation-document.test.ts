import { expect, test } from 'bun:test';

import { OperationProjectionError, projectOperation } from './operation-document';

const petSchema = () => ({
  oneOf: [
    { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  ],
});

function fixture() {
  const pet = petSchema();
  return {
    openapi: '3.1.0',
    info: { title: 'Pets', version: '1.0.0' },
    servers: [{ url: 'https://root.example.test' }],
    security: [{ bearerAuth: [] }],
    tags: [{ name: 'pets' }, { name: 'write' }],
    paths: {
      '/pets': {
        servers: [{ url: 'https://path.example.test' }],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'string' } }],
        get: { operationId: 'listPets', responses: { '200': { description: 'Listed' } } },
        post: {
          operationId: 'createPet',
          tags: ['pets', 'write'],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
          requestBody: {
            content: {
              'application/json': { schema: pet, example: { name: 'Mochi' } },
              'application/yaml': { schema: pet, example: 'name: Mochi' },
            },
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': {
                  schema: pet,
                  examples: { created: { value: { name: 'Mochi' } } },
                },
              },
            },
          },
        },
      },
      '/status': {
        servers: [{ url: 'https://status.example.test' }],
        get: {
          operationId: 'publicStatus',
          security: [],
          responses: { '200': { description: 'Healthy' } },
        },
      },
      '/override': {
        servers: [{ url: 'https://ignored.example.test' }],
        get: {
          operationId: 'overrideServer',
          servers: [{ url: 'https://operation.example.test' }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: {
      schemas: { Pet: pet, Unused: { type: 'string' } },
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
  };
}

function duplicateFixture() {
  const document = fixture();
  document.paths['/pets'].get.operationId = 'dup';
  document.paths['/pets'].post.operationId = 'dup';
  return document;
}

test('keeps one method and operation-level parameter override', () => {
  const projected = projectOperation(fixture(), 'createPet');
  expect(Object.keys(projected.paths['/pets'] ?? {})).toEqual(['post']);
  expect(projected.paths['/pets']?.post.parameters).toEqual([
    { name: 'limit', in: 'query', schema: { type: 'integer' } },
  ]);
});

test('preserves explicit empty security', () => {
  const projected = projectOperation(fixture(), 'publicStatus');
  expect(projected.paths['/status']?.get.security).toEqual([]);
});

test('rejects duplicate operation IDs', () => {
  expect(() => projectOperation(duplicateFixture(), 'dup')).toThrow('Duplicate operationId');
});

test('preserves inherited servers, root metadata, components, content, and multi-tags', () => {
  const source = fixture();
  const projected = projectOperation(source, 'createPet');
  const operation = projected.paths['/pets']?.post;

  expect(projected.openapi).toBe(source.openapi);
  expect(projected.info).toBe(source.info);
  expect(projected.security).toBe(source.security);
  expect(projected.servers).toBe(source.servers);
  expect(projected.components).toBe(source.components);
  expect(operation.servers).toEqual([{ url: 'https://path.example.test' }]);
  expect(operation.tags).toEqual(['pets', 'write']);
  expect(operation.requestBody.content).toEqual(source.paths['/pets'].post.requestBody.content);
  expect(operation.responses['201'].content['application/json'].schema.oneOf).toHaveLength(2);
  expect(Object.values(projected.paths).flatMap((path) => Object.keys(path))).toEqual(['post']);
});

test('prefers operation servers over path servers', () => {
  const projected = projectOperation(fixture(), 'overrideServer');
  expect(projected.paths['/override']?.get.servers).toEqual([{ url: 'https://operation.example.test' }]);
});

test('rejects an operation without an operationId', () => {
  const document = fixture();
  delete document.paths['/pets'].get.operationId;
  expect(() => projectOperation(document, 'createPet')).toThrow('Missing operationId for GET /pets');
});

test('rejects a missing requested operationId', () => {
  expect(() => projectOperation(fixture(), 'missing')).toThrow('Missing operationId "missing"');
});

test('rejects unresolved reference markers', () => {
  const document = fixture();
  Object.assign(document.components.schemas.Unused, { $ref: '#/components/schemas/Pet' });
  expect(() => projectOperation(document, 'createPet')).toThrow(OperationProjectionError);
  expect(() => projectOperation(document, 'createPet')).toThrow('Unresolved reference marker');
});
