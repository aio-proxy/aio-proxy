import { expect, test } from 'bun:test';

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { AvailableModelsRequestSchema, AvailableModelsResponseSchema } from '../../gen/aiserver_pb';
import { CURSOR_AVAILABLE_MODELS_PATH } from '../../wire';
import { frameConnectMessage } from '../../wire/frame';
import { fetchCursorFamilies } from './available-models';

const framedAvailable = (
  models: {
    name: string;
    variants: {
      legacySlug?: string;
      variantStringRepresentation?: string;
      isDefaultNonMaxConfig?: boolean;
    }[];
  }[],
) => frameConnectMessage(toBinary(AvailableModelsResponseSchema, create(AvailableModelsResponseSchema, { models })));

test('maps AvailableModels family variants and records the path', async () => {
  const paths: string[] = [];
  const transport = {
    openRun: () => Promise.reject(new Error('unused')),
    unary: async ({ path, body }: { path: string; body: Uint8Array }) => {
      paths.push(path);
      expect(fromBinary(AvailableModelsRequestSchema, body).useModelParameters).toBe(true);
      return {
        status: 200,
        body: framedAvailable([
          {
            name: 'claude-opus-4-8',
            variants: [
              {
                legacySlug: 'claude-opus-4-8-medium',
                isDefaultNonMaxConfig: true,
              },
            ],
          },
        ]),
      };
    },
  };

  const families = await fetchCursorFamilies({ accessToken: 't', transport: transport as never });

  expect(paths).toEqual([CURSOR_AVAILABLE_MODELS_PATH]);
  expect(families).toEqual([
    {
      name: 'claude-opus-4-8',
      variants: [{ slug: 'claude-opus-4-8-medium', isDefaultNonMax: true }],
    },
  ]);
});

test('uses variantStringRepresentation when legacySlug is empty and skips blank slugs', async () => {
  const transport = {
    openRun: () => Promise.reject(new Error('unused')),
    unary: async () => ({
      status: 200,
      body: framedAvailable([
        {
          name: 'claude-opus-4-8',
          variants: [
            { legacySlug: '   ', variantStringRepresentation: '  ' },
            { variantStringRepresentation: 'claude-opus-4-8-high' },
            { legacySlug: 'claude-opus-4-8-medium', isDefaultNonMaxConfig: false },
          ],
        },
      ]),
    }),
  };

  const families = await fetchCursorFamilies({ accessToken: 't', transport: transport as never });

  expect(families).toEqual([
    {
      name: 'claude-opus-4-8',
      variants: [{ slug: 'claude-opus-4-8-high' }, { slug: 'claude-opus-4-8-medium' }],
    },
  ]);
});

test('AvailableModels 503 throws a non-catalog error', async () => {
  const transport = {
    openRun: () => Promise.reject(new Error('unused')),
    unary: async () => ({ status: 503, body: new Uint8Array() }),
  };
  const error = await fetchCursorFamilies({ accessToken: 't', transport: transport as never }).catch(
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).not.toBe('CursorCatalogError');
});
