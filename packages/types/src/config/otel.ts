import { z } from 'zod';

import { ConfigTemplateStringSchema } from '../provider';

export const OtelContentTypeSchema = z.enum(['json', 'protobuf']);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const FORBIDDEN_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'host',
  'connection',
  'transfer-encoding',
  'user-agent',
]);

const HeaderNameSchema = z.string().min(1).max(256).regex(HEADER_NAME);
const HeaderValueSchema = z.string().min(1).max(4096);

function refineOtelUrl(value: string, context: z.RefinementCtx): void {
  if (value.length > 2048) {
    context.addIssue({ code: 'custom', message: 'OTLP URL is too long' });
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'OTLP URL is invalid' });
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'OTLP URL must be http or https' });
  }
  if (url.username !== '' || url.password !== '') {
    context.addIssue({ code: 'custom', message: 'OTLP URL cannot contain userinfo' });
  }
  if (url.hash !== '') {
    context.addIssue({ code: 'custom', message: 'OTLP URL cannot contain a fragment' });
  }
}

function refineHeaders(headers: Readonly<Record<string, string>>, context: z.RefinementCtx): void {
  if (Object.keys(headers).length > 16) {
    context.addIssue({ code: 'custom', message: 'Too many headers' });
    return;
  }
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    const folded = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(folded)) {
      context.addIssue({ code: 'custom', message: `Header ${name} is reserved`, path: [name] });
    }
    if (seen.has(folded)) {
      context.addIssue({ code: 'custom', message: `Duplicate header ${name}`, path: [name] });
    }
    seen.add(folded);
  }
}

const OtelHeadersSchema = z.record(HeaderNameSchema, HeaderValueSchema).default({}).superRefine(refineHeaders);

const OtelDestinationSchema = z.object({
  url: z.string().superRefine(refineOtelUrl),
  contentType: OtelContentTypeSchema.default('json'),
  headers: OtelHeadersSchema,
});

const OtelDestinationAuthoringSchema = z.object({
  url: z.union([z.string().superRefine(refineOtelUrl), ConfigTemplateStringSchema]),
  contentType: OtelContentTypeSchema.default('json'),
  headers: z
    .record(HeaderNameSchema, z.union([HeaderValueSchema, ConfigTemplateStringSchema]))
    .default({})
    .superRefine(refineHeaders),
});

export const ServerOtelSchema = z.object({
  destinations: z.array(OtelDestinationSchema).max(8).default([]),
});

export const ServerOtelAuthoringSchema = z.object({
  destinations: z.array(OtelDestinationAuthoringSchema).max(8).default([]),
});

export type OtelDestination = z.output<typeof OtelDestinationSchema>;
