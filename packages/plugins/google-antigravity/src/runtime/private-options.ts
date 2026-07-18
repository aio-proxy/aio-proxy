import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { type LogicalRequestContext, type ProviderExecutedTool, zod } from "@aio-proxy/plugin-sdk";
import type { AntigravityThinkingOption } from "../protocol/thinking";

const logicalRequestSchema = zod.custom<LogicalRequestContext>((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = Reflect.get(value, "session");
  return (
    typeof Reflect.get(value, "requestId") === "string" &&
    typeof session === "object" &&
    session !== null &&
    !Array.isArray(session) &&
    typeof Reflect.get(session, "key") === "string" &&
    Reflect.get(session, "key").startsWith("sha256:") &&
    typeof Reflect.get(session, "source") === "string"
  );
});

const thinkingSchema = zod.discriminatedUnion("mode", [
  zod.object({ mode: zod.literal("disabled") }),
  zod.object({ mode: zod.literal("fixed"), budgetTokens: zod.number().int().positive() }),
  zod.object({ mode: zod.literal("adaptive"), effort: zod.enum(["low", "medium", "high", "max"]) }),
]) satisfies zod.ZodType<AntigravityThinkingOption>;

const providerToolSchema = zod.object({
  type: zod.literal("web-search"),
  name: zod.string().min(1),
  maxUses: zod.number().int().positive().optional(),
  allowedDomains: zod.array(zod.string().min(1)).optional(),
  blockedDomains: zod.array(zod.string().min(1)).optional(),
});

const aioProxySchema = zod
  .object({
    logicalRequest: logicalRequestSchema,
    thinking: thinkingSchema.optional(),
    providerTools: zod.array(providerToolSchema).optional(),
  })
  .loose();

export function takeAioProxyOptions(providerOptions: SharedV4ProviderOptions | undefined) {
  const { aioProxy, ...rest } = providerOptions ?? {};
  const parsed = aioProxySchema.parse(aioProxy);
  const providerTools = parsed.providerTools?.map(providerTool);
  const privateOptions = {
    logicalRequest: parsed.logicalRequest,
    ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
    ...(providerTools === undefined ? {} : { providerTools }),
  };
  return { context: parsed.logicalRequest, privateOptions, providerOptions: rest };
}

function providerTool(tool: zod.output<typeof providerToolSchema>): ProviderExecutedTool {
  return {
    type: tool.type,
    name: tool.name,
    ...(tool.maxUses === undefined ? {} : { maxUses: tool.maxUses }),
    ...(tool.allowedDomains === undefined ? {} : { allowedDomains: tool.allowedDomains }),
    ...(tool.blockedDomains === undefined ? {} : { blockedDomains: tool.blockedDomains }),
  };
}
