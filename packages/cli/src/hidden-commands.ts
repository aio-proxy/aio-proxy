import { m } from '@aio-proxy/i18n';
import type { Command } from 'commander';

import type { CliDeps } from './dashboard-assets';
import { CliExit, EXIT } from './exit';

// Commands other programs run, never users: the upgrade's agent refresh, the desktop app's discovery, and
// the Windows service supervisor. Each loads its implementation on demand.
const registerHiddenPostUpgrade = (program: Command, deps: CliDeps, version: string): void => {
  program.command('__agent-post-upgrade', { hidden: true }).action(async () => {
    const [{ createAgentCommandDeps }, { readAgentPostUpgradePayload, runAgentPostUpgrade }] = await Promise.all([
      import('./agent'),
      import('./upgrade/post-upgrade-agents'),
    ]);
    const payload = await readAgentPostUpgradePayload();
    const agent = createAgentCommandDeps(deps);
    const results = await runAgentPostUpgrade(payload, {
      resolveLocation: agent.resolveLocation,
      inspect: agent.inspect,
      install: agent.install,
      readAssets: agent.readAssets,
      adapterVersion: version,
      now: agent.now,
    });
    console.log(JSON.stringify(results));
  });
};

const registerHiddenDesktopConnect = (program: Command, version: string): void => {
  program.command('__desktop-connect', { hidden: true }).action(async () => {
    const { defaultDesktopConnectDeps, printDesktopConnect } = await import('./desktop-connect');
    if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
      throw new CliExit(EXIT.unrecoverable, m['cli.service.unsupported_platform']({ platform: process.platform }));
    }
    const deps = await defaultDesktopConnectDeps(version);
    await printDesktopConnect(deps, (text) => process.stdout.write(text));
  });
};

// What the Windows Task Scheduler task runs: supervises `<exec> run` per the spec file. Not platform-gated
// so it can be exercised anywhere; the kill-on-close Job Object exists only on win32.
const registerHiddenServiceRun = (program: Command): void => {
  program.command('__service-run <spec>', { hidden: true }).action(async (specPath: string) => {
    const { defaultSupervisorDeps, runSupervisor } = await import('./service-run');
    process.exitCode = await runSupervisor(specPath, defaultSupervisorDeps(specPath));
  });
};

export const registerHiddenCommands = (program: Command, deps: CliDeps, version: string): void => {
  registerHiddenPostUpgrade(program, deps, version);
  registerHiddenDesktopConnect(program, version);
  registerHiddenServiceRun(program);
};
