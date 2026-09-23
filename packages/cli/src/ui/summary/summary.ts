import { m } from '@aio-proxy/i18n';
import {
  type DashboardProviderSummary,
  DashboardProvidersResponseSchema,
  dashboardProviderSuggestedCommand,
} from '@aio-proxy/types';

const ProviderListSchema = DashboardProvidersResponseSchema.pick({ providers: true });

function labelValue(label: string, value: string, color: boolean): string {
  const shown = color ? `\u001b[2m${label}\u001b[0m` : label;
  return `${shown}: ${value}`;
}

function fits(wide: string, columns: number | undefined): boolean {
  return columns !== undefined && columns >= 80 && Bun.stringWidth(wide) <= columns;
}

function providerFields(provider: DashboardProviderSummary, probe: boolean, color: boolean): string[] {
  const catalog = provider.state.status === 'ready' ? (provider.state.catalog ?? '-') : '-';
  const rows: readonly (readonly [string, string])[] = [
    [m['cli.provider.list.header_id'](), provider.id],
    [m['cli.provider.list.header_kind'](), provider.kind],
    [m['cli.provider.list.header_enabled'](), String(provider.enabled)],
    [m['cli.provider.list.header_passthrough'](), String(provider.passthrough)],
    [m['cli.provider.list.header_last_status'](), provider.last_status],
    [
      m['cli.provider.list.header_last_latency'](),
      provider.last_latency === null ? '-' : String(provider.last_latency),
    ],
    [m['cli.provider.list.header_state'](), provider.state.status],
    [m['cli.provider.list.header_catalog'](), catalog],
    [m['cli.provider.list.header_plugin'](), provider.plugin ?? '-'],
    [m['cli.provider.list.header_capability'](), provider.capability ?? '-'],
    [m['cli.provider.list.header_account'](), provider.accountLabel ?? '-'],
    [
      m['cli.provider.list.header_expires_at'](),
      provider.expiresAt === undefined ? '-' : new Date(provider.expiresAt).toISOString(),
    ],
    [m['cli.provider.list.header_catalog_last_success_at'](), provider.catalogLastSuccessAt ?? '-'],
    [m['cli.provider.list.header_diagnostic'](), provider.state.diagnostic?.summary ?? '-'],
    [m['cli.provider.list.header_suggested_command'](), dashboardProviderSuggestedCommand(provider) ?? '-'],
  ];
  const withProbe = probe
    ? [...rows, [m['cli.provider.list.header_probe'](), provider.probe ?? 'FAIL'] as const]
    : rows;
  return withProbe.map(([label, value]) => labelValue(label, value, color));
}

export function formatProviderLines(
  providers: readonly DashboardProviderSummary[],
  probe: boolean,
  color: boolean,
): readonly string[] {
  if (providers.length === 0) return [m['cli.ui.provider_list_empty']()];
  const lines: string[] = [];
  for (const provider of providers) {
    if (lines.length > 0) lines.push('');
    lines.push(...providerFields(provider, probe, color));
  }
  return lines;
}

export function formatDeepProviderLines(data: unknown, color: boolean): readonly string[] | undefined {
  const parsed = ProviderListSchema.safeParse(data);
  if (!parsed.success) return undefined;
  return formatProviderLines(parsed.data.providers, true, color);
}

export function formatPluginLines(
  plugin: {
    readonly label?: string;
    readonly packageName: string;
    readonly state: string;
    readonly description?: string;
  },
  columns: number | undefined,
): readonly string[] {
  const identity = plugin.label === undefined ? plugin.packageName : `${plugin.label} (${plugin.packageName})`;
  const wide = `${identity} ${plugin.state}${plugin.description === undefined ? '' : ` — ${plugin.description}`}`;
  if (fits(wide, columns)) return [wide];
  return [
    ...(plugin.label === undefined ? [] : [plugin.label]),
    plugin.packageName,
    plugin.state,
    ...(plugin.description === undefined ? [] : [plugin.description]),
  ];
}

export function formatInstalledLines(
  item: { readonly packageName: string; readonly version: string; readonly directory: string },
  columns: number | undefined,
): readonly string[] {
  const wide = `${item.packageName} ${item.version} ${item.directory}`;
  if (fits(wide, columns)) return [wide];
  return [item.packageName, item.version, item.directory];
}

export function formatDoctorLines(
  report: {
    readonly configPath: string;
    readonly url: string;
    readonly version?: string;
    readonly reachable: boolean;
    readonly pluginCount: number;
  },
  columns: number | undefined,
): readonly string[] {
  const configLine = m['cli.doctor.config_path']({ path: report.configPath });
  const serverLine = report.reachable
    ? `● ${m['cli.doctor.server_reachable']({ url: report.url, version: report.version ?? 'unknown' })}`
    : `○ ${m['cli.doctor.server_unreachable']({ url: report.url })}`;
  const pluginsLine = m['cli.doctor.plugin_count']({ count: report.pluginCount });
  const wide = `${configLine}  ${serverLine}  ${pluginsLine}`;
  if (fits(wide, columns)) return [wide];
  return [configLine, serverLine, pluginsLine];
}

export function formatStatusLine(status: {
  readonly running: boolean;
  readonly url: string;
  readonly version?: string;
}): string {
  return status.running
    ? `● ${m['cli.status.running']({ url: status.url, version: status.version ?? 'unknown' })}`
    : `○ ${m['cli.status.not_running']({ url: status.url })}`;
}

export function formatRunSummary(apiUrl: string, dashboardUrl: string): string {
  return `● ${m['cli.run.started']({ apiUrl, dashboardUrl })}`;
}
