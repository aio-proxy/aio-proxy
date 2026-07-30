import { configPath, listInstalledNpmPackages } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';

import { controlBaseUrl, probeHealth, resolveControlAddress } from '../control-plane';

export type DoctorOptions = {
  readonly host?: string;
  readonly port?: string;
};

// Read-only environment report: config path, whether a server answers /health
// on the given address, and how many plugin packages are installed. Never
// throws for an unreachable server — "not running" is a normal doctor finding.
export async function doctorCommand(
  options: DoctorOptions = {},
  print: (line: string) => void = console.log,
): Promise<void> {
  const { host, port } = await resolveControlAddress(options);
  const url = controlBaseUrl(host, port);

  print(m.cli_doctor_config_path({ path: configPath() }));

  const health = await probeHealth(url);
  print(
    health === null
      ? m.cli_doctor_server_unreachable({ url })
      : m.cli_doctor_server_reachable({ url, version: health.version ?? 'unknown' }),
  );

  const installed = await listInstalledNpmPackages();
  print(m.cli_doctor_plugin_count({ count: installed.length }));
}
