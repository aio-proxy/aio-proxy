import { z } from 'zod';

import { AiSdkProviderMutationBodySchema, ApiProviderMutationBodySchema, HttpProxyUrlSchema } from '../provider';

const DraftProxySchema = z.union([HttpProxyUrlSchema, z.literal(false), z.null(), z.literal('****')]).optional();

export const DashboardProviderDraftSchema = z.discriminatedUnion('kind', [
  ApiProviderMutationBodySchema.extend({ proxy: DraftProxySchema }).strict(),
  AiSdkProviderMutationBodySchema.extend({ proxy: DraftProxySchema }).strict(),
]);

const DashboardProviderDraftRequestFields = {
  draft: DashboardProviderDraftSchema,
  persistedProviderId: z.string().min(1).optional(),
} as const;

export const DashboardProviderDraftCatalogRequestSchema = z.strictObject(DashboardProviderDraftRequestFields);

export const DashboardProviderDraftTestRequestSchema = z.strictObject({
  ...DashboardProviderDraftRequestFields,
  model: z.string().trim().min(1),
});

export const DashboardProviderDraftCatalogResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), models: z.array(z.string()).readonly() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        'invalid_draft',
        'redacted_proxy_unsupported',
        'persisted_provider_not_found',
        'persisted_provider_mismatch',
        'persisted_provider_identity_mismatch',
        'catalog_unsupported',
        'catalog_unavailable',
      ]),
      recoverable: z.literal(true),
    }),
  }),
]);

export const DashboardProviderDraftTestResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        'invalid_draft',
        'redacted_proxy_unsupported',
        'persisted_provider_not_found',
        'persisted_provider_mismatch',
        'persisted_provider_identity_mismatch',
        'model_not_enabled',
        'test_request_failed',
      ]),
      recoverable: z.literal(true),
    }),
  }),
]);

export type DashboardProviderDraftInput = z.input<typeof DashboardProviderDraftSchema>;
export type DashboardProviderDraft = z.output<typeof DashboardProviderDraftSchema>;
export type DashboardProviderDraftCatalogRequestInput = z.input<typeof DashboardProviderDraftCatalogRequestSchema>;
export type DashboardProviderDraftCatalogRequest = z.output<typeof DashboardProviderDraftCatalogRequestSchema>;
export type DashboardProviderDraftTestRequestInput = z.input<typeof DashboardProviderDraftTestRequestSchema>;
export type DashboardProviderDraftTestRequest = z.output<typeof DashboardProviderDraftTestRequestSchema>;
export type DashboardProviderDraftCatalogResponse = z.output<typeof DashboardProviderDraftCatalogResponseSchema>;
export type DashboardProviderDraftTestResponse = z.output<typeof DashboardProviderDraftTestResponseSchema>;
