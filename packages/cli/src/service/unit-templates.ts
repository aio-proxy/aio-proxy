import { dirname } from 'node:path';

export type UnitOptions = {
  readonly exec: string;
  readonly configPath: string;
};

export const LAUNCHD_LABEL = 'com.aio-proxy.agent';
export const SYSTEMD_UNIT_NAME = 'aio-proxy.service';

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
ExecStart=${exec} run
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=1
Environment=AIO_PROXY_HOME=${dirname(configPath)}

[Install]
WantedBy=default.target
`;
}

// launchd user agent. ProgramArguments = [<exec>, run]. KeepAlive.SuccessfulExit
// = false mirrors the exit-code contract: relaunch unless the process exited
// cleanly (exit 0). RunAtLoad starts it as soon as it is loaded.
export function renderLaunchdPlist({ exec, configPath }: UnitOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exec}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIO_PROXY_HOME</key>
    <string>${dirname(configPath)}</string>
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
