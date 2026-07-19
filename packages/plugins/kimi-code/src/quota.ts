import type { AccountContext, OAuthQuotaItem, OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { kimiIdentityHeaders } from "./headers";
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies } from "./oauth";

const numberValue = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resetTime = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value > 1_000_000_000_000 ? value : value * 1_000);
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function item(value: unknown, id: string, label: OAuthQuotaItem["label"]): OAuthQuotaItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const limit = numberValue(Reflect.get(value, "limit"));
  if (limit === undefined || limit <= 0) return undefined;
  const remaining = numberValue(Reflect.get(value, "remaining"));
  const used = numberValue(Reflect.get(value, "used"));
  const ratio = remaining === undefined ? (used === undefined ? undefined : 1 - used / limit) : remaining / limit;
  const rawReset = ["resetTime", "resetAt", "reset_time", "reset_at"]
    .map((key) => Reflect.get(value, key))
    .find((candidate) => candidate !== undefined);
  const resetsAt = resetTime(rawReset);
  return {
    id,
    label,
    ...(ratio === undefined ? {} : { remainingRatio: Math.min(1, Math.max(0, ratio)) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

export async function readKimiQuota(
  context: AccountContext<KimiCredential, Record<string, never>>,
  dependencies: KimiOAuthDependencies = {},
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentKimiCredential(context.credentials, { ...dependencies, signal: context.signal });
  const response = await (dependencies.fetch ?? globalThis.fetch)("https://api.kimi.com/coding/v1/usages", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential.accessToken}`,
      ...kimiIdentityHeaders(credential.deviceId),
    },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Kimi quota request failed with ${response.status}`);
  const root: unknown = await response.json();
  if (typeof root !== "object" || root === null) throw new Error("Kimi quota response is invalid");

  const weekly = item(Reflect.get(root, "usage"), "weekly", {
    default: "Weekly quota",
    "zh-Hans": "周配额",
  });
  const rawLimits = Reflect.get(root, "limits");
  const limits = Array.isArray(rawLimits) ? rawLimits : [];
  const windows = limits.flatMap((entry, index): OAuthQuotaItem[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const window = Reflect.get(entry, "window");
    const duration =
      typeof window === "object" && window !== null ? numberValue(Reflect.get(window, "duration")) : undefined;
    const unit =
      typeof window === "object" && window !== null && typeof Reflect.get(window, "timeUnit") === "string"
        ? String(Reflect.get(window, "timeUnit"))
        : "window";
    const normalizedUnit = unit.toLowerCase().replaceAll("_", "-");
    const shortUnit = unit.includes("MINUTE")
      ? "minute"
      : unit.includes("HOUR")
        ? "hour"
        : unit.includes("DAY")
          ? "day"
          : "window";
    const displayDuration = duration ?? index + 1;
    const mapped = item(Reflect.get(entry, "detail"), `${duration ?? index}-${normalizedUnit}`, {
      default: `${displayDuration} ${shortUnit} quota`,
      "zh-Hans": `${displayDuration} ${
        shortUnit === "minute" ? "分钟" : shortUnit === "hour" ? "小时" : shortUnit === "day" ? "天" : "窗口"
      }配额`,
    });
    return mapped === undefined ? [] : [mapped];
  });
  const items = [...(weekly === undefined ? [] : [weekly]), ...windows];
  if (items.length === 0) throw new Error("Kimi quota response contains no valid windows");
  return { items };
}
