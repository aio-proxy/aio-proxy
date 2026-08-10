import { expect, test } from 'bun:test';

import { InvalidArgumentError } from '@ai-sdk/provider';
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

test('toolChoice none advertises no tools', () => {
  expect(buildMcpToolDefinitions([fn('search', {}), fn('read', {})], { type: 'none' })).toEqual([]);
});

test('a named tool choice advertises only the matching function tool', () => {
  expect(
    buildMcpToolDefinitions([fn('search', {}), fn('read', {})], { type: 'tool', toolName: 'read' }).map(
      (tool) => tool.toolName,
    ),
  ).toEqual(['aio_proxy__read']);
});

test('a named tool choice rejects a missing or provider-defined tool', () => {
  expect(() => buildMcpToolDefinitions([fn('search', {})], { type: 'tool', toolName: 'read' })).toThrow(
    /toolChoice.*read/i,
  );
  expect(() =>
    buildMcpToolDefinitions([{ type: 'provider', id: 'cursor.read', name: 'read', args: {} }], {
      type: 'tool',
      toolName: 'read',
    }),
  ).toThrow(/toolChoice.*read/i);
});

test('a named tool choice rejects when tools are undefined', () => {
  expect(() => buildMcpToolDefinitions(undefined, { type: 'tool', toolName: 'read' })).toThrow(InvalidArgumentError);
});

test('a named tool choice rejects when tools are empty', () => {
  expect(() => buildMcpToolDefinitions([], { type: 'tool', toolName: 'read' })).toThrow(InvalidArgumentError);
});

test('required keeps all usable function tools advertised', () => {
  expect(buildMcpToolDefinitions([fn('search', {}), fn('read', {})], { type: 'required' })).toHaveLength(2);
});
