import { configPath, listInstalledNpmPackages } from '@aio-proxy/core';

import { controlBaseUrl, probeHealth, resolveControlAddress } from '../control-plane';
import { formatDoctorLines } from '../ui';

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

  const health = await probeHealth(url);
  const installed = await listInstalledNpmPackages();
  for (const line of formatDoctorLines(
    {
      configPath: configPath(),
      url,
      ...(health?.version === undefined ? {} : { version: health.version }),
      reachable: health !== null,
      pluginCount: installed.length,
    },
    process.stdout.columns,
  )) {
    print(line);
  }
}
