import { m } from '@aio-proxy/i18n';

import { formatBlock, formatTable } from '../layout';
import type { Style } from '../style';

function fits(wide: string, columns: number | undefined): boolean {
  return columns !== undefined && columns >= 80 && Bun.stringWidth(wide) <= columns;
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
  style: Style,
  items: readonly { readonly packageName: string; readonly version: string; readonly directory: string }[],
): readonly string[] {
  return formatTable(
    style,
    items.map((item) => ({ cells: [style.strong(item.packageName), item.version, style.muted(item.directory)] })),
    [m['cli.ui.header_package'](), m['cli.ui.header_version'](), m['cli.ui.header_directory']()],
  );
}

const withVersion = (url: string, version: string | undefined): string =>
  version === undefined ? url : `${url} · v${version}`;

export function formatDoctorLines(
  style: Style,
  report: {
    readonly configPath: string;
    readonly url: string;
    readonly version?: string;
    readonly reachable: boolean;
    readonly pluginCount: number;
  },
): readonly string[] {
  const server = report.reachable
    ? { mark: style.mark('ok'), value: withVersion(report.url, report.version) }
    : { mark: style.mark('fail'), value: `${report.url} · ${m['cli.doctor.server_not_reachable']()}` };
  const plugins =
    report.pluginCount === 0
      ? { mark: style.mark('warn'), value: m['cli.doctor.plugins_none']() }
      : { mark: style.mark('ok'), value: m['cli.doctor.plugins_installed']({ count: report.pluginCount }) };
  return formatTable(style, [
    { mark: style.mark('ok'), cells: [m['cli.doctor.label_config'](), style.muted(report.configPath)] },
    { mark: server.mark, cells: [m['cli.doctor.label_server'](), style.muted(server.value)] },
    { mark: plugins.mark, cells: [m['cli.doctor.label_plugins'](), style.muted(plugins.value)] },
  ]);
}

export function formatStatusLine(
  style: Style,
  status: { readonly running: boolean; readonly url: string; readonly version?: string },
): string {
  return status.running
    ? `${style.mark('ok')} ${m['cli.status.state_running']()}  ${style.muted(withVersion(status.url, status.version))}`
    : `${style.mark('off')} ${m['cli.status.state_not_running']()}  ${style.muted(status.url)}`;
}

export function formatRunSummary(style: Style, apiUrl: string, dashboardUrl: string): readonly string[] {
  return formatBlock(style, {
    mark: style.mark('ok'),
    title: style.strong(m['cli.run.running']()),
    fields: [
      [m['cli.run.label_api'](), apiUrl],
      [m['cli.run.label_dashboard'](), dashboardUrl],
    ],
  });
}
