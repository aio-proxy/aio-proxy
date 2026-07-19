import type { AccountContext, OAuthQuotaItem, OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { createXAIGrokCLIHeaders, XAI_GROK_CLI_BASE_URL } from "./cli-headers";
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from "./oauth";
import type { XAIGrokCredential } from "./schema";

const WEEKLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing?format=credits`;
const MONTHLY_BILLING_URL = `${XAI_GROK_CLI_BASE_URL}/billing`;
type BillingObject = {
  readonly billing_period_end?: unknown;
  readonly billingPeriodEnd?: unknown;
  readonly config?: unknown;
  readonly credit_usage_percent?: unknown;
  readonly creditUsagePercent?: unknown;
  readonly current_period?: unknown;
  readonly currentPeriod?: unknown;
  readonly end?: unknown;
  readonly monthly_limit?: unknown;
  readonly monthlyLimit?: unknown;
  readonly used?: unknown;
  readonly val?: unknown;
};

export async function readXAIGrokQuota(
  context: AccountContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentXAIGrokCredential(context.credentials, { ...options, signal: context.signal });
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = createXAIGrokCLIHeaders(credential, { accept: "*/*" });
  if (credential.subject !== undefined) headers.set("x-userid", credential.subject);
  const results = await Promise.allSettled([
    requestBilling(fetcher, WEEKLY_BILLING_URL, headers, context.signal, weeklyItem),
    requestBilling(fetcher, MONTHLY_BILLING_URL, headers, context.signal, monthlyItem),
  ]);
  context.signal.throwIfAborted();
  const items = results.flatMap((result) =>
    result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
  );
  if (items.length === 0) throw new Error("xAI Grok billing request failed");
  return { items };
}

async function requestBilling(
  fetcher: NonNullable<XAIGrokOAuthOptions["fetch"]>,
  url: string,
  headers: Headers,
  signal: AbortSignal,
  toItem: (config: BillingObject) => OAuthQuotaItem | undefined,
): Promise<OAuthQuotaItem | undefined> {
  const response = await fetcher(url, { method: "GET", headers, signal });
  if (!response.ok) throw new Error(`xAI Grok billing request failed (${response.status})`);
  const payload = record(await response.json());
  return payload === undefined ? undefined : toItem(record(payload.config) ?? {});
}

function weeklyItem(config: BillingObject): OAuthQuotaItem | undefined {
  const period = record(config.currentPeriod ?? config.current_period);
  const remainingRatio = remainingFromPercent(config.creditUsagePercent ?? config.credit_usage_percent);
  const resetsAt = timestamp(period?.end);
  if (remainingRatio === undefined && resetsAt === undefined) return undefined;
  return {
    id: "weekly",
    label: { default: "Weekly limit", "zh-Hans": "周额度" },
    ...(remainingRatio === undefined ? {} : { remainingRatio }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function monthlyItem(config: BillingObject): OAuthQuotaItem | undefined {
  const limit = cents(config.monthlyLimit ?? config.monthly_limit);
  const used = cents(config.used);
  const remainingRatio =
    limit === undefined || limit <= 0 || used === undefined
      ? undefined
      : 1 - Math.min(Math.max(used, 0), limit) / limit;
  const resetsAt = timestamp(config.billingPeriodEnd ?? config.billing_period_end);
  if (remainingRatio === undefined && resetsAt === undefined) return undefined;
  return {
    id: "monthly-credits",
    label: { default: "Monthly credits", "zh-Hans": "月度额度" },
    ...(remainingRatio === undefined ? {} : { remainingRatio }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function record(value: unknown): BillingObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as BillingObject) : undefined;
}

function number(value: unknown): number | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  if (trimmed === "") return undefined;
  const parsed = typeof value === "number" ? value : trimmed === undefined ? Number.NaN : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cents(value: unknown): number | undefined {
  return number(record(value)?.val ?? value);
}

function remainingFromPercent(value: unknown): number | undefined {
  const used = number(value);
  return used === undefined ? undefined : 1 - Math.min(Math.max(used, 0), 100) / 100;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
