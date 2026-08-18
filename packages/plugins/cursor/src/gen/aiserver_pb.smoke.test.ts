import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { expect, test } from 'bun:test';

import { AvailableModelsRequestSchema, AvailableModelsResponseSchema } from './aiserver_pb';

test('aiserver AvailableModels request round-trips use_model_parameters', () => {
  const bytes = toBinary(
    AvailableModelsRequestSchema,
    create(AvailableModelsRequestSchema, { useModelParameters: true }),
  );
  expect(fromBinary(AvailableModelsRequestSchema, bytes).useModelParameters).toBe(true);
});

test('aiserver AvailableModels response round-trips a model entry', () => {
  const bytes = toBinary(
    AvailableModelsResponseSchema,
    create(AvailableModelsResponseSchema, {
      modelNames: ['claude-4.5-sonnet'],
      models: [{ name: 'claude-4.5-sonnet', defaultOn: true, contextTokenLimit: 200_000 }],
      useModelParameters: true,
    }),
  );
  const decoded = fromBinary(AvailableModelsResponseSchema, bytes);
  expect(decoded.modelNames).toEqual(['claude-4.5-sonnet']);
  expect(decoded.models[0]?.contextTokenLimit).toBe(200_000);
});
