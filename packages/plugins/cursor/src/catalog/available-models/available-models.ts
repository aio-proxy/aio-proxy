import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  type AvailableModelsResponse_AvailableModel,
  AvailableModelsRequestSchema,
  AvailableModelsResponseSchema,
} from '../../gen/aiserver_pb';
import { buildDiscoveryHeaders, CURSOR_AVAILABLE_MODELS_PATH, type CursorTransport } from '../../wire';
import { decodeConnectUnaryBody } from '../../wire/unary';

export type CursorFamilyVariant = {
  readonly slug: string;
  readonly isDefaultNonMax?: boolean;
};

export type CursorFamily = {
  readonly name: string;
  readonly variants: readonly CursorFamilyVariant[];
};

export async function fetchCursorFamilies(input: {
  readonly accessToken: string;
  readonly transport: CursorTransport;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<readonly CursorFamily[]> {
  const body = toBinary(
    AvailableModelsRequestSchema,
    create(AvailableModelsRequestSchema, { useModelParameters: true }),
  );
  const response = await input.transport.unary({
    path: CURSOR_AVAILABLE_MODELS_PATH,
    headers: buildDiscoveryHeaders({ accessToken: input.accessToken }),
    body,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    timeoutMs: input.timeoutMs ?? 15_000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.status !== 200) {
    throw new Error(`Cursor AvailableModels failed with status ${response.status}`);
  }
  const framed = decodeConnectUnaryBody(response.body) ?? response.body;
  const decoded = fromBinary(AvailableModelsResponseSchema, framed);
  return decoded.models.map(mapFamily);
}

function mapFamily(model: AvailableModelsResponse_AvailableModel): CursorFamily {
  const variants: CursorFamilyVariant[] = [];
  for (const variant of model.variants) {
    const slug = (variant.legacySlug ?? variant.variantStringRepresentation ?? '').trim();
    if (slug.length === 0) continue;
    variants.push({
      slug,
      ...(variant.isDefaultNonMaxConfig === true ? { isDefaultNonMax: true } : {}),
    });
  }
  return { name: model.name, variants };
}
