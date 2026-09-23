import { z, type ZodType } from 'zod';

import type { DocumentationContent, DocumentedPublicOperation } from './public-operations';

export const exampleSchema = <T extends ZodType>(schema: T, ...examples: unknown[]): T => schema.meta({ examples });

export const content = (contentType: string, schema: ZodType): DocumentationContent => ({ contentType, schema });
export const jsonContent = (schema: ZodType): DocumentationContent => content('application/json', schema);
export const binary = z.string().meta({ format: 'binary', description: 'Binary bytes, not a JSON string.' });
export const upstreamStream = content(
  'text/event-stream',
  z
    .string()
    .describe(
      'SSE bytes forwarded from a compatible raw provider. Event names and payloads depend on that provider; no converted streaming implementation is available for this operation.',
    ),
);
export const textContent = (contentType: string, example: string): DocumentationContent =>
  content(contentType, exampleSchema(z.string(), example));

export const parameter = (name: string, location: 'path' | 'query', schema = z.string()) => ({
  name,
  in: location,
  required: location === 'path',
  schema,
});

export function operation(
  method: DocumentedPublicOperation['method'],
  path: string,
  operationId: string,
  slug: string,
  tag: DocumentedPublicOperation['tag'],
  navOrder: number,
  fields: Partial<Pick<DocumentedPublicOperation, 'requestVariants' | 'responseVariants' | 'parameters' | 'routePath'>>,
): DocumentedPublicOperation {
  return {
    classification: 'documented',
    method,
    path,
    operationId,
    slug,
    tag,
    navOrder,
    messages: { title: `operations.${operationId}.title`, description: `operations.${operationId}.description` },
    responses: {},
    ...fields,
  };
}

export const ok = (...contents: DocumentationContent[]) => [
  {
    status: '200',
    description: 'Successful response. Available representations depend on the request and upstream capability.',
    content: contents,
  },
];

// Raw passthrough can add fields; these document the stable envelope, not every upstream extension.
export const upstreamObject = (example: Record<string, unknown>) =>
  exampleSchema(
    z
      .record(z.string(), z.unknown())
      .describe(
        'Upstream JSON object; fields depend on the selected provider. See the example and compatibility notes.',
      ),
    example,
  );
