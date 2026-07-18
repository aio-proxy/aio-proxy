import { ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD } from "../oauth/constants";
import type { GoogleAntigravityAccountOptions } from "../schema";
import { normalizeBaseURL } from "../schema";

export type AntigravityOperation = "project-load" | "onboarding" | "discovery" | "inference" | "count";

export function antigravityEndpoints(
  options: GoogleAntigravityAccountOptions,
  operation: AntigravityOperation,
): readonly string[] {
  const custom = normalizeBaseURL(options.baseURL);
  if (custom !== undefined) return [custom];
  if (operation === "project-load") return [ANTIGRAVITY_PROD];
  if (operation === "onboarding") return [ANTIGRAVITY_DAILY];
  return [ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD];
}
