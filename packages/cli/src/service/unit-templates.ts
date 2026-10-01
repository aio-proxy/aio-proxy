import { dirname } from 'node:path';

export type UnitOptions = {
  readonly exec: string;
  readonly configPath: string;
  readonly path?: string;
  readonly upgradeMethod?: 'brew' | 'bun' | 'npm' | 'pnpm' | 'desktop';
  /** Set only for a desktop-owned unit; the daemon inherits it so any later rewrite keeps the symlink. */
  readonly desktopExec?: string;
};

export const LAUNCHD_LABEL = 'com.aio-proxy.agent';
export const SYSTEMD_UNIT_NAME = 'aio-proxy.service';

// systemd splits command lines on whitespace unless a token is double-quoted, and
// treats `%` as a specifier and `\` / `"` as escapes. Quote the value and escape
// those metacharacters so an exec or config-home path containing spaces (or any of
// them) is passed as a single literal argument instead of being truncated.
const systemdQuote = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

// systemd user unit. `ExecStart=<exec> run` starts the long-running proxy.
// Restart=on-failure + RestartPreventExitStatus=1 honors the CLI exit-code
// contract: exit 1 is unrecoverable (bad config/input), so systemd must not
// restart on it; any other non-zero exit is transient and gets restarted.
// The daemon loads the optional service.env itself (see service-env), so no
// EnvironmentFile= is needed and the env file is parsed identically on both
// platforms without a shell.
export function renderSystemdUnit({ exec, configPath, path, upgradeMethod }: UnitOptions): string {
  return `[Unit]
Description=AIO Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(exec)} run
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=1
Environment=${systemdQuote(`AIO_PROXY_HOME=${dirname(configPath)}`)}
Environment=${systemdQuote('AIO_PROXY_MANAGED=1')}${path === undefined ? '' : `\nEnvironment=${systemdQuote(`PATH=${path}`)}`}${upgradeMethod === undefined ? '' : `\nEnvironment=${systemdQuote(`AIO_PROXY_UPGRADE_METHOD=${upgradeMethod}`)}`}

[Install]
WantedBy=default.target
`;
}

// launchd user agent. launchd has no RestartPreventExitStatus equivalent, so a
// /bin/sh wrapper remaps exit 1 (unrecoverable: bad config/input) to 0. With
// KeepAlive.SuccessfulExit=false, exit 0 is treated as a clean stop and is NOT
// relaunched, while transient exits (2+) pass through and are relaunched. This
// mirrors the systemd unit's RestartPreventExitStatus=1. RunAtLoad starts it on
// load. The wrapper only remaps the exit code; it never sources the env file
// (the daemon loads service.env itself), so no shell touches provider secrets.
//
// `[ -x "$0" ] || exit 0` turns a vanished executable (desktop app deleted, brew uninstalled) into a
// clean exit, which SuccessfulExit=false does not relaunch; otherwise launchd respawns it forever.
export const LAUNCHD_EXEC_WRAPPER =
  '[ -x "$0" ] || exit 0; "$0" run; status=$?; if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"';

/** Wrappers written by earlier releases; still recognized as ours when inspecting an installed plist. */
export const LEGACY_LAUNCHD_EXEC_WRAPPERS: readonly string[] = [
  '"$0" run; status=$?; if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"',
];

const launchdText = (name: string, value: string): Bun.XML.NodeInput => ({ name, children: [value] });
const launchdEmpty = (name: string): Bun.XML.NodeInput => ({ name, children: [] });
const launchdDict = (children: Bun.XML.NodeInput[]): Bun.XML.NodeInput => ({ name: 'dict', children });

export function renderLaunchdPlist({ exec, configPath, path, upgradeMethod, desktopExec }: UnitOptions): string {
  const environmentVariables = [
    launchdText('key', 'AIO_PROXY_HOME'),
    launchdText('string', dirname(configPath)),
    launchdText('key', 'AIO_PROXY_MANAGED'),
    launchdText('string', '1'),
    ...(path === undefined ? [] : [launchdText('key', 'PATH'), launchdText('string', path)]),
    ...(upgradeMethod === undefined
      ? []
      : [launchdText('key', 'AIO_PROXY_UPGRADE_METHOD'), launchdText('string', upgradeMethod)]),
    ...(desktopExec === undefined
      ? []
      : [launchdText('key', 'AIO_PROXY_DESKTOP_EXEC'), launchdText('string', desktopExec)]),
  ];
  const plist: Bun.XML.NodeInput = {
    name: 'plist',
    attributes: { version: '1.0' },
    children: [
      launchdDict([
        launchdText('key', 'Label'),
        launchdText('string', LAUNCHD_LABEL),
        launchdText('key', 'ProgramArguments'),
        {
          name: 'array',
          children: [
            launchdText('string', '/bin/sh'),
            launchdText('string', '-c'),
            launchdText('string', LAUNCHD_EXEC_WRAPPER),
            launchdText('string', exec),
          ],
        },
        launchdText('key', 'EnvironmentVariables'),
        launchdDict(environmentVariables),
        launchdText('key', 'KeepAlive'),
        launchdDict([launchdText('key', 'SuccessfulExit'), launchdEmpty('false')]),
        launchdText('key', 'RunAtLoad'),
        launchdEmpty('true'),
      ]),
    ],
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${Bun.XML.stringify(plist, null, 2)}
`;
}
