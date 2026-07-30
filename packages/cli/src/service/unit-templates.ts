import { dirname, join } from 'node:path';

export type UnitOptions = {
  readonly exec: string;
  readonly configPath: string;
};

export const LAUNCHD_LABEL = 'com.aio-proxy.agent';
export const SYSTEMD_UNIT_NAME = 'aio-proxy.service';

// A managed run (systemd/launchd) starts from a clean environment and does not
// inherit the installing shell. Provider secrets referenced in config via
// {{env.*}} would otherwise resolve to empty strings, so both unit templates
// source this optional env file (`KEY=value` per line) that lives next to the
// config. ponytail: convention file mirrors systemd EnvironmentFile / tailscale
// TS_AUTHKEY practice; move to systemd LoadCredential=/launchd Keychain if a
// maintainer wants secrets kept out of a readable env file.
export const SERVICE_ENV_FILENAME = 'service.env';
export const serviceEnvFile = (configPath: string): string => join(dirname(configPath), SERVICE_ENV_FILENAME);

// systemd splits command lines on whitespace unless a token is double-quoted, and
// treats `%` as a specifier and `\` / `"` as escapes. Quote the value and escape
// those metacharacters so an exec or config-home path containing spaces (or any of
// them) is passed as a single literal argument instead of being truncated.
const systemdQuote = (value: string): string =>
  `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

// launchd plist strings are XML element text, so a `&`, `<`, or `>` in a path would
// produce a malformed plist that the LaunchAgent cannot load. Escape them.
const xmlEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// systemd user unit. `ExecStart=<exec> run` starts the long-running proxy.
// Restart=on-failure + RestartPreventExitStatus=1 honors the CLI exit-code
// contract: exit 1 is unrecoverable (bad config/input), so systemd must not
// restart on it; any other non-zero exit is transient and gets restarted.
export function renderSystemdUnit({ exec, configPath }: UnitOptions): string {
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
EnvironmentFile=-${systemdQuote(serviceEnvFile(configPath))}

[Install]
WantedBy=default.target
`;
}

// launchd user agent. launchd has no RestartPreventExitStatus equivalent, so a
// /bin/sh wrapper remaps exit 1 (unrecoverable: bad config/input) to 0. With
// KeepAlive.SuccessfulExit=false, exit 0 is treated as a clean stop and is NOT
// relaunched, while transient exits (2+) pass through and are relaunched. This
// mirrors the systemd unit's RestartPreventExitStatus=1. RunAtLoad starts it on load.
const LAUNCHD_EXEC_WRAPPER =
  'set -a; [ -f "$1" ] && . "$1"; set +a; "$0" run; status=$?; if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"';

export function renderLaunchdPlist({ exec, configPath }: UnitOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xmlEscape(LAUNCHD_EXEC_WRAPPER)}</string>
    <string>${xmlEscape(exec)}</string>
    <string>${xmlEscape(serviceEnvFile(configPath))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIO_PROXY_HOME</key>
    <string>${xmlEscape(dirname(configPath))}</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}
