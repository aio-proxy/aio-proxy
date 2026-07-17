import { zod } from "@aio-proxy/plugin-sdk";
import type { PluginFormPrompts } from "./index";

export type PromptCall = { type: string; config: unknown; signal?: AbortSignal };

export function prompts(values: readonly unknown[], calls: PromptCall[] = []): PluginFormPrompts {
  let index = 0;
  const next = (type: string) => async (config: unknown, context?: { signal?: AbortSignal }) => {
    calls.push({ type, config, signal: context?.signal });
    return values[index++];
  };
  return {
    input: next("input") as PluginFormPrompts["input"],
    password: next("password") as PluginFormPrompts["password"],
    confirm: next("confirm") as PluginFormPrompts["confirm"],
    select: next("select") as PluginFormPrompts["select"],
  };
}

export const spec = {
  schema: zod.object({
    endpoint: zod.string().url(),
    token: zod.string().min(1).optional(),
    retries: zod.number().int(),
    enabled: zod.boolean(),
    region: zod.enum(["us", "eu"]),
    advanced: zod.object({ mode: zod.literal("strict") }),
  }),
  form: [
    { type: "text", key: "endpoint", label: "Endpoint" },
    { type: "secret", key: "token", label: "Token" },
    { type: "number", key: "retries", label: "Retries" },
    { type: "boolean", key: "enabled", label: "Enabled", defaultValue: false },
    {
      type: "select",
      key: "region",
      label: "Region",
      options: [
        { label: "US", value: "us" },
        { label: "EU", value: "eu" },
      ],
    },
    { type: "json", key: "advanced", label: "Advanced" },
  ],
} as const;
