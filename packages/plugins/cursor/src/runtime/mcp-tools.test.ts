import { expect, test } from 'bun:test';

import { fromBinary, fromJson, toBinary } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import { buildMcpToolDefinitions } from './mcp-tools';

const fn = (name: string, inputSchema: Record<string, unknown>, description?: string) => ({
  type: 'function' as const,
  name,
  inputSchema,
  ...(description === undefined ? {} : { description }),
});

test('maps a caller tool and preserves its JSON schema through Value bytes', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
  const [definition] = buildMcpToolDefinitions([fn('search_docs', schema, 'Search the docs')]);
  expect(definition?.name).toBe('search_docs');
  expect(definition?.toolName).toBe('search_docs');
  expect(definition?.providerIdentifier).toBe('pi-agent');
  expect(definition?.description).toBe('Search the docs');
  const decoded = fromBinary(ValueSchema, definition!.inputSchema);
  expect(toBinary(ValueSchema, decoded)).toEqual(toBinary(ValueSchema, fromJson(ValueSchema, schema as never)));
});

test('escapes a reserved caller name and defaults a missing description', () => {
  const [definition] = buildMcpToolDefinitions([fn('read', { type: 'object' })]);
  expect(definition?.name).toBe('aio_proxy__read');
  expect(definition?.toolName).toBe('aio_proxy__read');
  expect(definition?.description).toBe('');
});

test('returns an empty array for no tools', () => {
  expect(buildMcpToolDefinitions(undefined)).toEqual([]);
  expect(buildMcpToolDefinitions([])).toEqual([]);
});
