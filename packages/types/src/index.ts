import { z } from "zod";

const IdSchema = z.string().min(1);

export const ServerConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(22_078),
  dashboardPort: z.number().int().min(1).max(65_535).default(22_079),
});

export const ModelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    alias: IdSchema,
    id: IdSchema,
  }),
]);

const ApiVendorSchema = z.enum([
  "openai-native",
  "anthropic-native",
  "google-native",
  "openai-compatible",
]);

export const ProviderProtocolSchema = z.enum([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate-content",
]);

export const ApiProviderSchema = z.object({
  kind: z.literal("api"),
  id: z.string().optional(),
  name: z.string().optional(),
  vendor: ApiVendorSchema,
  protocol: ProviderProtocolSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  models: z.array(ModelEntrySchema).optional(),
});

export const SubscriptionProviderSchema = z.object({
  kind: z.literal("subscription"),
  id: z.string(),
  vendor: z.literal("github-copilot"),
  models: z.array(ModelEntrySchema).optional(),
});

export const AiSdkProviderSchema = z.object({
  kind: z.literal("ai-sdk"),
  id: z.string(),
  packageName: z.string().default("@ai-sdk/openai-compatible"),
  providerName: z.string().optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  parseReasoningContent: z.boolean().optional(),
  models: z.array(ModelEntrySchema).optional(),
});

export const ProviderSchema = z.discriminatedUnion("kind", [
  ApiProviderSchema,
  SubscriptionProviderSchema,
  AiSdkProviderSchema,
]);

export const ConfigSchema = z.object({
  server: ServerConfigSchema.prefault({}),
  providers: z.array(ProviderSchema),
});

export const UsageRowSchema = z.object({
  providerId: IdSchema,
  modelId: IdSchema,
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
});

const TraceBaseSchema = z.object({
  traceId: IdSchema,
  timestamp: z.string().datetime(),
});

export const TraceEventSchema = z.discriminatedUnion("type", [
  TraceBaseSchema.extend({
    type: z.literal("start"),
    providerId: IdSchema,
    modelId: IdSchema,
  }),
  TraceBaseSchema.extend({
    type: z.literal("delta"),
    textDelta: z.string(),
  }),
  TraceBaseSchema.extend({
    type: z.literal("end"),
    usage: UsageRowSchema.optional(),
  }),
  TraceBaseSchema.extend({
    type: z.literal("error"),
    error: z.object({
      message: z.string().min(1),
      code: z.string().optional(),
    }),
  }),
]);

export const DashboardProviderProbeSchema = z.enum(["OK", "FAIL"]);

export const DashboardProviderSummarySchema = z.object({
  id: IdSchema,
  kind: z.enum(["api", "ai-sdk", "subscription"]),
  enabled: z.boolean(),
  passthrough: z.boolean(),
  last_status: z.string(),
  last_latency: z.number().int().min(0).nullable(),
  probe: DashboardProviderProbeSchema.optional(),
});

export const DashboardProvidersResponseSchema = z.object({
  providers: z.array(DashboardProviderSummarySchema),
});

export const DashboardEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("config.changed"),
    data: z.object({
      providerIds: z.object({
        added: z.array(IdSchema),
        removed: z.array(IdSchema),
      }),
    }),
  }),
  z.object({
    event: z.literal("events.dropped"),
    data: z.object({
      queuedBytes: z.number().int().min(0),
      queuedEvents: z.number().int().min(0),
    }),
  }),
  z.object({
    event: z.literal("trace.delta"),
    data: z.object({
      trace_id: IdSchema,
      textDelta: z.string(),
    }),
  }),
]);

const AioContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    image: z.string(),
    mediaType: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: IdSchema,
    toolName: IdSchema,
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: IdSchema,
    toolName: IdSchema,
    output: z.unknown(),
  }),
]);

export const AioModelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(AioContentPartSchema)]),
});

export const AioStreamPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    messageId: IdSchema.optional(),
  }),
  z.object({
    type: z.literal("text-delta"),
    textDelta: z.string(),
  }),
  z.object({
    type: z.literal("finish"),
    usage: UsageRowSchema.optional(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      message: z.string().min(1),
      code: z.string().optional(),
    }),
  }),
]);

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ApiProvider = z.infer<typeof ApiProviderSchema>;
export type SubscriptionProvider = z.infer<typeof SubscriptionProviderSchema>;
export type AiSdkProvider = z.infer<typeof AiSdkProviderSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type UsageRow = z.infer<typeof UsageRowSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type DashboardProviderProbe = z.infer<
  typeof DashboardProviderProbeSchema
>;
export type DashboardProviderSummary = z.infer<
  typeof DashboardProviderSummarySchema
>;
export type DashboardProvidersResponse = z.infer<
  typeof DashboardProvidersResponseSchema
>;
export type DashboardEvent = z.infer<typeof DashboardEventSchema>;
export type AioModelMessage = z.infer<typeof AioModelMessageSchema>;
export type AioStreamPart = z.infer<typeof AioStreamPartSchema>;
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;
