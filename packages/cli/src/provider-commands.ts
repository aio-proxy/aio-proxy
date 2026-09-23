import { dirname } from 'node:path';

import {
  listInstalledNpmPackages,
  NpmInstallError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
} from '@aio-proxy/core';
import { type DashboardProviderSummary, DashboardProvidersResponseSchema } from '@aio-proxy/types';

import { ProviderDashboardError } from './errors';
import { providerImport as pluginProviderImport } from './plugin-commands/provider-import';
import { type ProviderLoginOptions, providerLogin as pluginProviderLogin } from './plugin-commands/provider-login';
import { formatInstalledLines, formatProviderLines, useColor } from './ui';

export type ProviderListOptions = {
  readonly filter?: string;
  readonly installed?: boolean;
  readonly probe?: boolean;
  readonly url?: string;
};

const defaultDashboardUrl = 'http://127.0.0.1:9317';
const DashboardProviderListResponseSchema = DashboardProvidersResponseSchema.pick({ providers: true });

export const providerErrors = [
  NpmInstallError,
  NpmPackageNameError,
  NpmPackageJsonError,
  NpmPackageEntrypointError,
] as const;

export async function providerLogin(capability: string | undefined, options: ProviderLoginOptions): Promise<void> {
  await pluginProviderLogin(capability, options);
}

export async function providerImport(path: string | undefined): Promise<void> {
  await pluginProviderImport(path);
}

export async function providerList(options: ProviderListOptions): Promise<void> {
  if (options.installed === true) {
    await providerInstalledList();
    return;
  }

  const url = new URL('/dashboard/api/providers', options.url ?? defaultDashboardUrl);
  if (options.probe === true) {
    url.searchParams.set('probe', 'true');
  }
  if (options.filter !== undefined) {
    url.searchParams.set('filter', options.filter);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new ProviderDashboardError(response.status, url.toString());
  }
  // Provider listing does not consume the routing revision. Parsing only the
  // field it owns keeps a newer CLI compatible with Dashboard servers from
  // before routing revisions were added.
  const parsed = DashboardProviderListResponseSchema.parse(await response.json());
  printProviderTable(parsed.providers, options.probe === true);
}

export async function providerTest(id: string, options: Omit<ProviderListOptions, 'filter' | 'probe'>): Promise<void> {
  await providerList({ ...options, filter: id, probe: true });
}

async function providerInstalledList(): Promise<void> {
  const installed = await listInstalledNpmPackages();
  if (installed.length === 0) return;
  for (const item of installed) {
    for (const line of formatInstalledLines(
      { packageName: item.packageName, version: item.version, directory: dirname(item.entrypoint) },
      process.stdout.columns,
    )) {
      console.log(line);
    }
  }
}

function printProviderTable(providers: readonly DashboardProviderSummary[], probe: boolean): void {
  const color = useColor(process.stdout.isTTY === true, process.env);
  for (const line of formatProviderLines(providers, probe, color)) {
    console.log(line);
  }
}
