import { dereference, validate } from '@scalar/openapi-parser';
import { z, type ZodType } from 'zod';

import {
  AnthropicBase64ImageSourceSchema,
  AnthropicThinkingBlockSchema,
  AnthropicToolResultBlockSchema,
  AnthropicUrlImageSourceSchema,
  AnthropicWebSearchToolSchema,
  GeminiEmbedContentRequestSchema,
  GeminiGenerateContentRequestSchema,
  GeminiInteractionsBodySchema,
  OpenAIImageEditsInputSchema,
  OpenAIImageGenerationsInputSchema,
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
import { appendRawVariant, projectGeminiMedia, projectTrimmedModelSchemas } from './schema-projections';

type JsonObject = Record<string, unknown>;
type Catalog = typeof en;

const documentedOperations = publicOperations
  .filter((operation): operation is DocumentedPublicOperation => operation.classification === 'documented')
  .sort((left, right) => left.navOrder - right.navOrder);

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const dallE3ModelPattern = '^\\s*(?:[^/\\s]+/)?dall-e-3\\s*$';

function projectGeminiInteractions(target: JsonObject): void {
  const properties = target.properties as JsonObject;
  const nonBlank = (schema: JsonObject | undefined): JsonObject => ({
    ...(schema ?? { type: 'string' }),
    minLength: 1,
    pattern: '\\S',
  });
  properties.model = nonBlank(properties.model as JsonObject | undefined);
  properties.agent = nonBlank(properties.agent as JsonObject | undefined);
  target.oneOf = [
    { type: 'object', properties: { model: properties.model }, required: ['model'] },
    { type: 'object', properties: { agent: properties.agent }, required: ['agent'] },
  ];
}

function projectImageCount(target: JsonObject): void {
  const properties = target.properties as JsonObject;
  const n = properties.n as JsonObject | undefined;
  if (n === undefined) return;
  const range = { type: 'integer', minimum: 1, maximum: 10 };
  const dallE3 = { anyOf: [{ type: 'integer', const: 1 }, { type: 'null' }] };
  const general = { anyOf: [range, { type: 'null' }] };
  target.allOf = [
    {
      if: { properties: { model: { type: 'string', pattern: dallE3ModelPattern } }, required: ['model'] },
      then: { properties: { n: dallE3 } },
      else: { properties: { n: general } },
    },
  ];
}

function validatePublicOperations(): void {
  const routeKeys = new Set<string>();
  const operationIds = new Set<string>();
  const slugs = new Set<string>();
  const navOrders = new Set<number>();

  for (const operation of publicOperations) {
    if (!['documented', 'deferred', 'unsupported'].includes(operation.classification)) {
      throw new Error('Invalid public operation classification');
    }
    if (
      !['delete', 'get', 'post'].includes(operation.method) ||
      !nonEmptyString(operation.path) ||
      !operation.path.startsWith('/')
    ) {
      throw new Error('Invalid public route identity');
    }
    const routeKey = `${operation.method.toUpperCase()} ${operation.path}`;
    if (routeKeys.has(routeKey)) throw new Error(`Duplicate public route "${routeKey}"`);
    routeKeys.add(routeKey);

    if (operation.classification !== 'documented') continue;
    if (!nonEmptyString(operation.operationId)) throw new Error(`Missing operationId for ${routeKey}`);
    if (operationIds.has(operation.operationId)) throw new Error(`Duplicate operationId "${operation.operationId}"`);
    operationIds.add(operation.operationId);

    if (!nonEmptyString(operation.slug)) throw new Error(`Missing slug for ${operation.operationId}`);
    if (slugs.has(operation.slug)) throw new Error(`Duplicate operation slug "${operation.slug}"`);
    slugs.add(operation.slug);

    if (!Number.isSafeInteger(operation.navOrder) || operation.navOrder < 0) {
      throw new Error(`Invalid navOrder for ${operation.operationId}`);
    }
    if (navOrders.has(operation.navOrder)) throw new Error(`Duplicate navOrder ${operation.navOrder}`);
    navOrders.add(operation.navOrder);

    if (!(operation.tag in en.tags)) throw new Error(`Invalid tag for ${operation.operationId}`);
    if (
      typeof operation.messages !== 'object' ||
      operation.messages === null ||
      !nonEmptyString(operation.messages.title) ||
      !nonEmptyString(operation.messages.description)
    ) {
      throw new Error(`Missing messages for ${operation.operationId}`);
    }
    if (operation.messages.note !== undefined && !nonEmptyString(operation.messages.note)) {
      throw new Error(`Invalid note for ${operation.operationId}`);
    }
    if (
      operation.request !== undefined &&
      (operation.request.contentType !== 'application/json' ||
        typeof operation.request.schema?.safeParse !== 'function')
    ) {
      throw new Error(`Invalid request metadata for ${operation.operationId}`);
    }
    if (
      operation.responses.json !== undefined &&
      (operation.responses.json.contentType !== 'application/json' ||
        typeof operation.responses.json.schema?.safeParse !== 'function')
    ) {
      throw new Error(`Invalid JSON response metadata for ${operation.operationId}`);
    }
    if (
      operation.responses.stream !== undefined &&
      (operation.responses.stream.contentType !== 'text/event-stream' ||
        typeof operation.responses.stream.schema?.safeParse !== 'function' ||
        typeof operation.responses.stream.formatExample !== 'function')
    ) {
      throw new Error(`Invalid stream response metadata for ${operation.operationId}`);
    }
  }
}

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
        if (zodSchema === GeminiGenerateContentRequestSchema.shape.contents.element.shape.parts.element) {
          target.oneOf = Object.entries(target.properties as JsonObject).map(([key, property]) => ({
            type: 'object',
            properties: { [key]: property },
            required: [key],
          }));
          projectGeminiMedia(target);
        } else if (
          zodSchema === GeminiInteractionsBodySchema ||
          (zodSchema instanceof z.ZodObject &&
            ['model', 'agent', 'input', 'previous_interaction_id'].every((key) => key in zodSchema.shape))
        ) {
          projectGeminiInteractions(target);
        } else if (
          zodSchema === OpenAIImageGenerationsInputSchema ||
          zodSchema === OpenAIImageEditsInputSchema ||
          (zodSchema instanceof z.ZodObject &&
            ['prompt', 'n', 'output_format', 'output_compression'].every((key) => key in zodSchema.shape))
        ) {
          projectImageCount(target);
        } else if (zodSchema === GeminiEmbedContentRequestSchema.shape.embedContentConfig.unwrap().in) {
          const properties = target.properties as JsonObject;
          properties.audioTrackExtraction = { not: {} };
          properties.documentOcr = { not: {} };
        } else if (zodSchema === GeminiEmbedContentRequestSchema.shape.content) {
          const properties = target.properties as JsonObject;
          (properties.parts as JsonObject).contains = {
            properties: { text: { type: 'string', minLength: 1 } },
            required: ['text'],
          };
        } else if (zodSchema === openAIResponsesInputItemTransformSchema) {
          appendRawVariant(target, convert(openAIResponsesInputItemSchema), [
            'message',
            'function_call',
            'function_call_output',
            'web_search_call',
            'custom_tool_call',
            'custom_tool_call_output',
            'reasoning',
            'item_reference',
            'additional_tools',
            'agent_message',
          ]);
        } else if (zodSchema === openAIResponsesToolTransformSchema) {
          appendRawVariant(target, convert(openAIResponsesToolWireSchema), [
            'function',
            'custom',
            'namespace',
            'web_search',
          ]);
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
            minLength: 4,
            pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
          });
        } else if (zodSchema === AnthropicUrlImageSourceSchema) {
          const properties = target.properties as JsonObject | undefined;
          if (properties !== undefined) {
            properties.url = {
              anyOf: [
                { type: 'string', format: 'uri', pattern: '^[hH][tT][tT][pP][sS]?://' },
                {
                  type: 'string',
                  pattern:
                    '^data:image/[A-Za-z0-9!#$&^_.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$',
                },
              ],
            };
          }
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

  const converted = convert(schema);
  projectTrimmedModelSchemas(converted);
  const examples = schema.meta()?.examples;
  if (Array.isArray(examples)) converted.examples = examples;
  return converted;
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

function schemaExamples(schema: ZodType, label: string): readonly unknown[] {
  const examples = schema.meta()?.examples;
  if (!Array.isArray(examples) || examples.length === 0) throw new Error(`Missing examples for ${label}`);
  for (const [index, example] of examples.entries()) {
    const parsed = schema.safeParse(example);
    if (!parsed.success) throw new Error(`Invalid example for ${label} at index ${index}`);
  }
  return examples;
}

function operationObject(operation: DocumentedPublicOperation): JsonObject {
  const description = [
    message(en, operation.messages.description),
    operation.messages.note === undefined ? undefined : message(en, operation.messages.note),
  ]
    .filter((value) => value !== undefined)
    .join('\n\n');
  const content: Record<string, JsonObject> = {};
  for (const response of [operation.responses.json, operation.responses.stream]) {
    if (response === undefined) continue;
    const examples = schemaExamples(response.schema, `${operation.operationId} ${response.contentType} response`);
    content[response.contentType] = {
      schema: jsonSchema(response.schema, 'output'),
      ...(response.contentType === 'text/event-stream' ? { example: response.formatExample(examples) } : {}),
    };
  }

  if (operation.request !== undefined) {
    const examples = schemaExamples(operation.request.schema, `${operation.operationId} request`);
    if (
      operation.responses.stream !== undefined &&
      !examples.some(
        (example) => typeof example === 'object' && example !== null && Reflect.get(example, 'stream') === true,
      )
    ) {
      throw new Error(`Missing stream: true request example for ${operation.operationId}`);
    }
  }

  const media = (entries: readonly { contentType: string; schema: ZodType }[], io: 'input' | 'output') => {
    const result: Record<string, JsonObject> = {};
    for (const entry of entries) {
      if (entry.contentType in result) throw new Error(`Duplicate content type for ${operation.operationId}`);
      const examples =
        io === 'output' && entry.contentType !== 'application/json' && entry.schema.meta()?.examples === undefined
          ? []
          : schemaExamples(entry.schema, `${operation.operationId} ${entry.contentType}`);
      result[entry.contentType] = {
        schema: jsonSchema(entry.schema, io),
        ...(examples.length > 0 ? { example: examples[0] } : {}),
      };
    }
    return result;
  };
  const requests = [
    ...(operation.request === undefined ? [] : [operation.request]),
    ...(operation.requestVariants ?? []),
  ];
  const responses: Record<string, JsonObject> =
    Object.keys(content).length === 0 ? {} : { '2XX': { description: 'Successful response', content } };
  for (const response of operation.responseVariants ?? []) {
    if (response.status in responses) throw new Error(`Duplicate response for ${operation.operationId}`);
    responses[response.status] = {
      description: response.description,
      ...(response.content === undefined ? {} : { content: media(response.content, 'output') }),
      ...(response.headers === undefined ? {} : { headers: response.headers }),
    };
  }
  return {
    operationId: operation.operationId,
    summary: message(en, operation.messages.title),
    description,
    tags: [en.tags[operation.tag]],
    ...(operation.parameters === undefined
      ? {}
      : {
          parameters: operation.parameters.map(({ schema, ...parameter }) => ({
            ...parameter,
            schema: jsonSchema(schema, 'input'),
          })),
        }),
    ...(requests.length === 0
      ? {}
      : {
          requestBody: {
            required: true,
            content: media(requests, 'input'),
          },
        }),
    responses,
  };
}

function sourceDocument(): JsonObject {
  validatePublicOperations();
  const paths: Record<string, JsonObject> = {};
  for (const operation of documentedOperations) {
    const pathItem = paths[operation.path] ?? {};
    pathItem[operation.method] = operationObject(operation);
    paths[operation.path] = pathItem;
  }
  return {
    openapi: '3.1.0',
    info: { title: en.shared.apiTitle, version: 'latest' },
    tags: Object.entries(en.tags).map(([name, description]) => ({ name: description, 'x-tag-id': name })),
    security: [{}, { bearerAuth: [] }],
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
