import { m } from '@aio-proxy/i18n';
import {
  type DashboardProviderSummary,
  DashboardProvidersResponseSchema,
  dashboardProviderSuggestedCommand,
} from '@aio-proxy/types';

import { type Block, type Field, formatBlock, formatTable, type TableRow } from '../layout';
import type { Style } from '../style';

const ProviderListSchema = DashboardProvidersResponseSchema.pick({ providers: true });

function providerMark(style: Style, provider: DashboardProviderSummary): string {
  if (!provider.enabled) return style.mark('off');
  if (provider.state.status === 'unavailable') return style.mark('fail');
  if (provider.state.catalog === 'stale' || provider.state.diagnostic !== undefined) return style.mark('warn');
  return style.mark('ok');
}

const stateCell = (style: Style, provider: DashboardProviderSummary): string =>
  provider.state.status === 'ready' ? style.success('ready') : style.danger(provider.state.status);

function catalogCell(style: Style, provider: DashboardProviderSummary): string {
  const catalog = provider.state.status === 'ready' ? provider.state.catalog : undefined;
  if (catalog === undefined) return style.muted('-');
  return catalog === 'stale' ? style.warning(catalog) : catalog;
}

const probeCell = (style: Style, provider: DashboardProviderSummary): string =>
  provider.probe === 'OK' ? style.success('OK') : style.danger('FAIL');

function providerRow(style: Style, provider: DashboardProviderSummary, probe: boolean): TableRow {
  const suggested = dashboardProviderSuggestedCommand(provider);
  const summary = provider.state.diagnostic?.summary;
  return {
    mark: providerMark(style, provider),
    cells: [
      style.strong(provider.id),
      provider.kind,
      stateCell(style, provider),
      catalogCell(style, provider),
      provider.last_latency === null ? style.muted('-') : `${provider.last_latency}ms`,
      ...(probe ? [probeCell(style, provider)] : []),
    ],
    notes: [
      ...(summary === undefined ? [] : [style.muted(summary)]),
      ...(suggested === undefined ? [] : [`${style.mark('hint')} ${style.muted(suggested)}`]),
    ],
  };
}

function providerBlock(style: Style, provider: DashboardProviderSummary, probe: boolean): Block {
  const catalog = provider.state.status === 'ready' ? (provider.state.catalog ?? '-') : '-';
  const fields: Field[] = [
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
  if (probe) fields.push([m['cli.provider.list.header_probe'](), provider.probe ?? 'FAIL']);
  return { mark: providerMark(style, provider), title: style.strong(provider.id), fields };
}

export function formatProviderLines(
  style: Style,
  providers: readonly DashboardProviderSummary[],
  probe: boolean,
): readonly string[] {
  if (providers.length === 0) return [m['cli.ui.provider_list_empty']()];
  if (providers.length === 1) return formatBlock(style, providerBlock(style, providers[0]!, probe));
  const headers = [
    m['cli.provider.list.header_id'](),
    m['cli.provider.list.header_kind'](),
    m['cli.provider.list.header_state'](),
    m['cli.provider.list.header_catalog'](),
    m['cli.provider.list.header_last_latency'](),
    ...(probe ? [m['cli.provider.list.header_probe']()] : []),
  ];
  return formatTable(
    style,
    providers.map((provider) => providerRow(style, provider, probe)),
    headers,
  );
}

export function formatDeepProviderLines(style: Style, data: unknown): readonly string[] | undefined {
  const parsed = ProviderListSchema.safeParse(data);
  if (!parsed.success) return undefined;
  return formatProviderLines(style, parsed.data.providers, true);
}
