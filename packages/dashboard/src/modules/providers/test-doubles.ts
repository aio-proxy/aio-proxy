import type { DashboardProviderSummary } from "@aio-proxy/types";
import type React from "react";
import { createElement } from "react";

export const DeleteProviderDialogStub: React.FC = () => null;

export const RouterLinkStub: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = (props) =>
  createElement("a", props);

export const providerStub = (overrides: Partial<DashboardProviderSummary> = {}): DashboardProviderSummary => ({
  id: "provider-id",
  kind: "oauth",
  enabled: true,
  passthrough: false,
  last_status: "unknown",
  last_latency: null,
  clientModels: [],
  state: { status: "ready" },
  ...overrides,
});
