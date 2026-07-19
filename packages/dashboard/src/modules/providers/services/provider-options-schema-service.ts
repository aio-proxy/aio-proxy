import { queryOptions } from "@tanstack/react-query";

import { createDashboardClient } from "@/lib/dashboard-client";

const dashboardClient = createDashboardClient();

export class ProviderPackageRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`provider package request failed: ${status} ${code}`);
    this.name = "ProviderPackageRequestError";
  }
}

export const throwRequestError = async (response: Response): Promise<never> => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const code =
    typeof payload === "object" && payload !== null && "code" in payload && typeof payload.code === "string"
      ? payload.code
      : "request_failed";
  throw new ProviderPackageRequestError(response.status, code);
};

export const providerInstallRequestBody = (packageName: string, confirmed: boolean) =>
  confirmed ? { npm: packageName, confirmed: true } : { npm: packageName };

export const providerPackageStatusQueryOptions = (packageName: string) =>
  queryOptions({
    queryKey: ["providers", "package-status", packageName],
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.providers["package-status"].$get({
        query: { npm: packageName },
      });
      if (!response.ok) {
        return throwRequestError(response);
      }
      return response.json();
    },
  });

export const installProviderPackage = async ({
  packageName,
  confirmed,
}: {
  readonly packageName: string;
  readonly confirmed: boolean;
}) => {
  const json = providerInstallRequestBody(packageName, confirmed);
  const response = await dashboardClient.dashboard.api.providers.install.$post({ json });
  if (!response.ok) {
    return throwRequestError(response);
  }
  return response.json();
};
