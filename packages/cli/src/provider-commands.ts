import { dirname } from "node:path";
import {
  listInstalledNpmPackages,
  NpmInstallError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  npmAdd,
} from "@aio-proxy/core";
import {
  type DashboardProviderSummary,
  DashboardProvidersResponseSchema,
} from "@aio-proxy/types";
import { confirm } from "@inquirer/prompts";
import { ProviderDashboardError } from "./errors";

export type ProviderInstallOptions = {
  readonly yes?: boolean;
  readonly registry?: string;
};

export type ProviderListOptions = {
  readonly filter?: string;
  readonly installed?: boolean;
  readonly probe?: boolean;
  readonly url?: string;
};

const defaultDashboardUrl = "http://127.0.0.1:22078";

export const providerErrors = [
  NpmInstallError,
  NpmPackageNameError,
  NpmPackageJsonError,
  NpmPackageEntrypointError,
] as const;

export async function providerInstall(
  pkg: string,
  options: ProviderInstallOptions,
): Promise<void> {
  if (options.yes !== true && !(await confirmInstall(pkg))) {
    console.error(`provider install ${pkg} requires --yes`);
    process.exitCode = 1;
    return;
  }
  const installed = await npmAdd(pkg, options.registry);
  console.log(`${pkg} ${installed.version} ${installed.entrypoint}`);
}

async function confirmInstall(pkg: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  return confirm({
    default: false,
    message: `Install and dynamically load ${pkg}? Only continue if you trust this package.`,
  });
}

export async function providerList(
  options: ProviderListOptions,
): Promise<void> {
  if (options.installed === true) {
    await providerInstalledList();
    return;
  }

  const url = new URL(
    "/dashboard/providers",
    options.url ?? defaultDashboardUrl,
  );
  if (options.probe === true) {
    url.searchParams.set("probe", "true");
  }
  if (options.filter !== undefined) {
    url.searchParams.set("filter", options.filter);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new ProviderDashboardError(response.status, url.toString());
  }
  const parsed = DashboardProvidersResponseSchema.parse(await response.json());
  printProviderTable(parsed.providers, options.probe === true);
}

export async function providerTest(
  id: string,
  options: Omit<ProviderListOptions, "filter" | "probe">,
): Promise<void> {
  await providerList({ ...options, filter: id, probe: true });
}

async function providerInstalledList(): Promise<void> {
  const installed = await listInstalledNpmPackages();
  for (const item of installed) {
    console.log(
      `${item.packageName} ${item.version} ${dirname(item.entrypoint)}`,
    );
  }
}

function printProviderTable(
  providers: readonly DashboardProviderSummary[],
  probe: boolean,
): void {
  const headers = [
    "id",
    "kind",
    "enabled",
    "passthrough",
    "last_status",
    "last_latency",
    ...(probe ? ["probe"] : []),
  ];
  console.log(headers.join(" | "));
  for (const provider of providers) {
    console.log(
      [
        provider.id,
        provider.kind,
        String(provider.enabled),
        String(provider.passthrough),
        provider.last_status,
        provider.last_latency === null ? "-" : String(provider.last_latency),
        ...(probe ? [provider.probe ?? "FAIL"] : []),
      ].join(" | "),
    );
  }
}
