import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

export enum ProviderProtocol {
  OpenAIResponse = 'openai-response',
  OpenAICompatible = 'openai-compatible',
  Anthropic = 'anthropic',
  Gemini = 'gemini',
  OpenAIImage = 'openai-image',
}

export const ProviderProtocolSchema = z
  .enum(ProviderProtocol)
  .describe('Wire protocol supported by this provider base URL.');

export const ProviderEndpointAuthSchema = z
  .enum(['bearer', 'x-api-key'])
  .describe('Anthropic endpoints only: bearer sends Authorization, x-api-key (default) sends x-api-key.');

export type ProviderEndpointAuth = z.output<typeof ProviderEndpointAuthSchema>;

// Strict so a typo (a per-entry `headers`, or `auth` on the shared form where it
// has no meaning) fails loudly instead of being stripped into a silent no-op.
export const ApiEndpointEntrySchema = z.strictObject({
  protocol: ProviderProtocolSchema,
  baseURL: z.url().describe('AI SDK-style base URL for this protocol endpoint.'),
  auth: ProviderEndpointAuthSchema.optional(),
});

export const ApiEndpointsInputSchema = z
  .union([
    z.array(ApiEndpointEntrySchema).min(1),
    z.strictObject({
      baseURL: z.url().describe('AI SDK-style base URL shared by every listed protocol.'),
      protocol: z.array(ProviderProtocolSchema).min(1),
    }),
  ])
  .describe('Additional protocol endpoints natively served by this provider.');

export type ApiEndpointEntry = z.output<typeof ApiEndpointEntrySchema>;
export type ApiEndpointsInput = z.output<typeof ApiEndpointsInputSchema>;

export type NormalizedApiEndpoint = {
  readonly protocol: ProviderProtocol;
  readonly baseURL: string;
  readonly auth?: ProviderEndpointAuth;
  readonly mode: 'origin' | 'sdk';
};

export type ApiEndpointsSource = {
  readonly protocol?: ProviderProtocol | undefined;
  readonly baseURL?: string | undefined;
  readonly endpoints?: ApiEndpointsInput | undefined;
};

export function apiProviderEndpoints(
  provider: ApiEndpointsSource,
): readonly [NormalizedApiEndpoint, ...NormalizedApiEndpoint[]] {
  const endpoints: NormalizedApiEndpoint[] = [];
  if (provider.protocol !== undefined && provider.baseURL !== undefined) {
    endpoints.push({ protocol: provider.protocol, baseURL: provider.baseURL, mode: 'origin' });
  }
  endpoints.push(...expandedEntries(provider.endpoints));
  const [primary, ...rest] = endpoints;
  if (primary === undefined) throw new TypeError('API provider declares no protocol endpoint');
  return [primary, ...rest];
}

function expandedEntries(input: ApiEndpointsInput | undefined): readonly NormalizedApiEndpoint[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) {
    return input.map((entry) => ({
      protocol: entry.protocol,
      baseURL: entry.baseURL,
      ...(entry.auth === undefined ? {} : { auth: entry.auth }),
      mode: 'sdk' as const,
    }));
  }
  return input.protocol.map((protocol) => ({ protocol, baseURL: input.baseURL, mode: 'sdk' as const }));
}

type EndpointsValidationSource = {
  readonly kind?: unknown;
  readonly protocol?: unknown;
  readonly baseURL?: unknown;
  readonly endpoints?: unknown;
  readonly apiKey?: unknown;
};

export function validateApiEndpoints(provider: EndpointsValidationSource, ctx: z.RefinementCtx): void {
  if (provider.kind !== 'api') return;
  const hasProtocol = provider.protocol !== undefined;
  const hasBaseUrl = provider.baseURL !== undefined;
  if (hasProtocol !== hasBaseUrl) {
    ctx.addIssue({
      code: 'custom',
      message: 'protocol and baseURL must be provided together',
      path: [hasProtocol ? 'baseURL' : 'protocol'],
    });
    return;
  }
  if (provider.endpoints === undefined) {
    if (!hasProtocol) {
      ctx.addIssue({ code: 'custom', message: 'protocol/baseURL or endpoints is required', path: ['protocol'] });
    }
    return;
  }
  const seen = new Set<string>();
  const legacyProtocol = concreteProtocol(provider.protocol);
  if (legacyProtocol !== undefined) seen.add(legacyProtocol);
  for (const entry of endpointValidationEntries(provider.endpoints)) {
    if (entry.protocol !== undefined) {
      if (seen.has(entry.protocol)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate endpoint protocol "${entry.protocol}"`,
          path: entry.protocolPath,
        });
      }
      seen.add(entry.protocol);
      if (entry.auth !== undefined && entry.protocol !== ProviderProtocol.Anthropic) {
        ctx.addIssue({
          code: 'custom',
          message: 'auth is only supported on anthropic endpoints',
          path: entry.authPath,
        });
      }
      if (entry.auth === 'bearer' && entry.protocol === ProviderProtocol.Anthropic && provider.apiKey === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: "auth 'bearer' requires apiKey",
          path: entry.authPath,
        });
      }
    }
  }
}

type EndpointValidationEntry = {
  readonly protocol: string | undefined;
  readonly auth: unknown;
  // zod's addIssue takes a mutable path array, so these cannot be readonly.
  readonly protocolPath: (string | number)[];
  readonly authPath: (string | number)[];
};

const PROTOCOL_VALUES = new Set<string>(Object.values(ProviderProtocol));

// Authoring configs may still hold `{{env.NAME}}` template strings; those are
// validated again after expansion, so non-enum strings are skipped here.
function concreteProtocol(value: unknown): string | undefined {
  return typeof value === 'string' && PROTOCOL_VALUES.has(value) ? value : undefined;
}

function endpointValidationEntries(endpoints: unknown): readonly EndpointValidationEntry[] {
  if (Array.isArray(endpoints)) {
    return endpoints.map((entry, index) => ({
      protocol: concreteProtocol(isPlainObject(entry) ? entry['protocol'] : undefined),
      auth: isPlainObject(entry) ? entry['auth'] : undefined,
      protocolPath: ['endpoints', index, 'protocol'],
      authPath: ['endpoints', index, 'auth'],
    }));
  }
  if (isPlainObject(endpoints) && Array.isArray(endpoints['protocol'])) {
    return endpoints['protocol'].map((value, index) => ({
      protocol: concreteProtocol(value),
      auth: undefined,
      protocolPath: ['endpoints', 'protocol', index],
      authPath: ['endpoints', 'protocol', index],
    }));
  }
  return [];
}
