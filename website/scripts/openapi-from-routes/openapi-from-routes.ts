import { dereference, validate } from '@scalar/openapi-parser';
import { z, type ZodType } from 'zod';

import {
  AnthropicBase64ImageSourceSchema,
  AnthropicThinkingBlockSchema,
  AnthropicToolResultBlockSchema,
  AnthropicUrlImageSourceSchema,
  AnthropicWebSearchToolSchema,
  openAIResponsesInputImagePartSchema,
  openAIResponsesInputItemSchema,
  openAIResponsesInputItemTransformSchema,
  openAIResponsesToolTransformSchema,
  openAIResponsesToolWireSchema,
} from '../../../packages/core/dist/index.js';
import {
  publicOperations,
  type DocumentedPublicOperation,
} from '../../../packages/server/src/server/public-operations';
import en from '../../i18n/en.json';
import { type OpenApiDocument, projectOperation } from '../operation-document/index';

type JsonObject = Record<string, unknown>;
type Catalog = typeof en;

const documentedOperations = publicOperations
  .filter((operation): operation is DocumentedPublicOperation => operation.classification === 'documented')
  .sort((left, right) => left.navOrder - right.navOrder);

const replaceObject = (target: JsonObject, source: JsonObject): void => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
};

function jsonSchema(schema: ZodType, io: 'input' | 'output'): JsonObject {
  const convert = (value: ZodType): JsonObject =>
    z.toJSONSchema(value, {
      cycles: 'throw',
      io,
      reused: 'inline',
      target: 'draft-2020-12',
      unrepresentable: ({ zodSchema }) => (zodSchema instanceof z.ZodUndefined ? { not: {} } : 'throw'),
      override: ({ zodSchema, jsonSchema: generated }) => {
        const target = generated as JsonObject;
        if (zodSchema === openAIResponsesInputItemTransformSchema) {
          replaceObject(target, convert(openAIResponsesInputItemSchema));
        } else if (zodSchema === openAIResponsesToolTransformSchema) {
          replaceObject(target, convert(openAIResponsesToolWireSchema));
        } else if (zodSchema === openAIResponsesInputImagePartSchema) {
          target.oneOf = [{ required: ['image_url'] }, { required: ['file_id'] }];
        } else if (zodSchema === AnthropicToolResultBlockSchema) {
          const required = Array.isArray(target.required) ? target.required : [];
          target.required = [...new Set([...required, 'tool_use_id'])];
        } else if (zodSchema === AnthropicThinkingBlockSchema) {
          const properties = target.properties as JsonObject | undefined;
          if (properties !== undefined) properties.cache_control = { not: {} };
        } else if (zodSchema === AnthropicBase64ImageSourceSchema) {
          const properties = target.properties as JsonObject | undefined;
          Object.assign(properties?.media_type as JsonObject, { pattern: '^image/[A-Za-z0-9!#$&^_.+-]+$' });
          Object.assign(properties?.data as JsonObject, {
            pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
          });
        } else if (zodSchema === AnthropicUrlImageSourceSchema) {
          const properties = target.properties as JsonObject | undefined;
          Object.assign(properties?.url as JsonObject, { pattern: '^https?://[^/\\s?#]+' });
        } else if (zodSchema === AnthropicWebSearchToolSchema) {
          target.oneOf = [
            {
              properties: {
                allowed_domains: { type: 'array', minItems: 1 },
                blocked_domains: { anyOf: [{ type: 'array', maxItems: 0 }, { type: 'null' }] },
              },
              required: ['allowed_domains'],
            },
            {
              properties: {
                allowed_domains: { anyOf: [{ type: 'array', maxItems: 0 }, { type: 'null' }] },
                blocked_domains: { type: 'array', minItems: 1 },
              },
              required: ['blocked_domains'],
            },
            {
              properties: {
                allowed_domains: { anyOf: [{ type: 'array', maxItems: 0 }, { type: 'null' }] },
                blocked_domains: { anyOf: [{ type: 'array', maxItems: 0 }, { type: 'null' }] },
              },
            },
          ];
        }
      },
    }) as JsonObject;

  return convert(schema);
}

function message(catalog: Catalog, id: string): string {
  let value: unknown = catalog;
  for (const segment of id.split('.')) {
    if (typeof value !== 'object' || value === null || !(segment in value)) {
      throw new Error(`Missing locale message "${id}"`);
    }
    value = Reflect.get(value, segment);
  }
  if (typeof value !== 'string') throw new Error(`Locale message "${id}" is not a string`);
  return value;
}

function operationObject(operation: DocumentedPublicOperation): JsonObject {
  const description = [
    message(en, operation.messages.description),
    operation.messages.note === undefined ? undefined : message(en, operation.messages.note),
  ]
    .filter((value) => value !== undefined)
    .join('\n\n');
  const content = Object.fromEntries(
    [operation.responses.json, operation.responses.stream]
      .filter((response) => response !== undefined)
      .map((response) => [response.contentType, { schema: jsonSchema(response.schema, 'output') }]),
  );

  return {
    operationId: operation.operationId,
    summary: message(en, operation.messages.title),
    description,
    tags: [en.tags[operation.tag]],
    ...(operation.request === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              [operation.request.contentType]: { schema: jsonSchema(operation.request.schema, 'input') },
            },
          },
        }),
    responses: {
      '200': {
        description: 'Successful response',
        content,
      },
    },
  };
}

function sourceDocument(): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const operation of documentedOperations) {
    paths[operation.path] = { [operation.method]: operationObject(operation) };
  }
  return {
    openapi: '3.1.0',
    info: { title: en.shared.apiTitle, version: 'latest' },
    tags: Object.entries(en.tags).map(([name, description]) => ({ name: description, 'x-tag-id': name })),
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}

const formatErrors = (errors: readonly { readonly message: string }[] | undefined): string =>
  errors?.map((error) => error.message).join('; ') ?? 'unknown error';

export async function loadPublicOpenApi(): Promise<OpenApiDocument> {
  const validated = await validate(sourceDocument());
  if (!validated.valid) throw new Error(`Invalid generated OpenAPI: ${formatErrors(validated.errors)}`);

  const dereferenced = dereference(validated.specification);
  if (dereferenced.specification === undefined || (dereferenced.errors?.length ?? 0) > 0) {
    throw new Error(`Could not dereference generated OpenAPI: ${formatErrors(dereferenced.errors)}`);
  }
  const document = dereferenced.specification as OpenApiDocument;

  const finalValidation = await validate(document);
  if (!finalValidation.valid) throw new Error(`Invalid dereferenced OpenAPI: ${formatErrors(finalValidation.errors)}`);
  for (const operation of documentedOperations) {
    const projected = projectOperation(document, operation.operationId);
    const projectionValidation = await validate(projected);
    if (!projectionValidation.valid) {
      throw new Error(`Invalid ${operation.operationId} projection: ${formatErrors(projectionValidation.errors)}`);
    }
  }
  JSON.parse(JSON.stringify(document));
  return document;
}

export function operationSlugs(document: OpenApiDocument): readonly string[] {
  const paths = document.paths ?? {};
  return documentedOperations
    .filter((operation) => {
      const path = paths[operation.path];
      const value = path?.[operation.method];
      return (
        typeof value === 'object' &&
        value !== null &&
        'operationId' in value &&
        value.operationId === operation.operationId
      );
    })
    .map((operation) => operation.slug);
}
