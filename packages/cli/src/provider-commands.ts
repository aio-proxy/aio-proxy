import { dirname } from 'node:path';

import {
  listInstalledNpmPackages,
  NpmInstallError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
} from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import {
  type DashboardProviderSummary,
  DashboardProvidersResponseSchema,
  dashboardProviderSuggestedCommand,
} from '@aio-proxy/types';

import { ProviderDashboardError } from './errors';
import { providerImport as pluginProviderImport } from './plugin-commands/provider-import';
import { type ProviderLoginOptions, providerLogin as pluginProviderLogin } from './plugin-commands/provider-login';

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
  for (const item of installed) {
    console.log(`${item.packageName} ${item.version} ${dirname(item.entrypoint)}`);
  }
}

function printProviderTable(providers: readonly DashboardProviderSummary[], probe: boolean): void {
  const headers = [
    m['cli.provider.list.header_id'](),
    m['cli.provider.list.header_kind'](),
    m['cli.provider.list.header_enabled'](),
    m['cli.provider.list.header_passthrough'](),
    m['cli.provider.list.header_last_status'](),
    m['cli.provider.list.header_last_latency'](),
    m['cli.provider.list.header_state'](),
    m['cli.provider.list.header_catalog'](),
    m['cli.provider.list.header_plugin'](),
    m['cli.provider.list.header_capability'](),
    m['cli.provider.list.header_account'](),
    m['cli.provider.list.header_expires_at'](),
    m['cli.provider.list.header_catalog_last_success_at'](),
    m['cli.provider.list.header_diagnostic'](),
    m['cli.provider.list.header_suggested_command'](),
    ...(probe ? [m['cli.provider.list.header_probe']()] : []),
  ];
  console.log(headers.join(' | '));
  for (const provider of providers) {
    const diagnostic = provider.state.diagnostic;
    console.log(
      [
        provider.id,
        provider.kind,
        String(provider.enabled),
        String(provider.passthrough),
        provider.last_status,
        provider.last_latency === null ? '-' : String(provider.last_latency),
        provider.state.status,
        provider.state.status === 'ready' ? (provider.state.catalog ?? '-') : '-',
        provider.plugin ?? '-',
        provider.capability ?? '-',
        provider.accountLabel ?? '-',
        provider.expiresAt === undefined ? '-' : new Date(provider.expiresAt).toISOString(),
        provider.catalogLastSuccessAt ?? '-',
        diagnostic?.summary ?? '-',
        dashboardProviderSuggestedCommand(provider) ?? '-',
        ...(probe ? [provider.probe ?? 'FAIL'] : []),
      ].join(' | '),
    );
  }
}
