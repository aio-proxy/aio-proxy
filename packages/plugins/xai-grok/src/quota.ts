import type { AccountContext, OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from "./oauth";
import { parseXAIGrokBilling, validateXAIGrokGrpcStatus } from "./quota-protobuf";
import type { XAIGrokCredential } from "./schema";

const BILLING_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

export async function readXAIGrokQuota(
  context: AccountContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthQuotaSnapshot> {
  const credential = await currentXAIGrokCredential(context.credentials, { ...options, signal: context.signal });
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(BILLING_URL, {
      method: "POST",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": "application/grpc-web+proto",
        origin: "https://grok.com",
        referer: "https://grok.com/?_s=usage",
        "user-agent": "aio-proxy",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
      },
      body: Uint8Array.of(0, 0, 0, 0, 0),
      signal: context.signal,
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new Error("xAI Grok billing request failed");
  }
  if (!response.ok) throw new Error(`xAI Grok billing request failed (${response.status})`);
  validateXAIGrokGrpcStatus(response.headers);
  const billing = parseXAIGrokBilling(new Uint8Array(await response.arrayBuffer()), options.now?.());
  return {
    items: [
      {
        id: "credits",
        label: { default: "Credits", "zh-Hans": "额度" },
        remainingRatio: Math.max(0, Math.min(1, 1 - billing.usedPercent / 100)),
        ...(billing.resetsAt === undefined ? {} : { resetsAt: billing.resetsAt }),
      },
    ],
  };
}
