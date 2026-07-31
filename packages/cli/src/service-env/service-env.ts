import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

export const SERVICE_ENV_FILENAME = 'service.env';

export const serviceEnvFile = (configPath: string): string => join(dirname(configPath), SERVICE_ENV_FILENAME);

// A managed run (systemd/launchd) starts from a clean environment and does not
// inherit the installing shell, so provider secrets referenced in config via
// {{env.*}} would otherwise resolve to empty strings. The daemon loads this
// optional `KEY=value` file itself, parsed as DATA (node:util.parseEnv) and
// never through a shell, so a value like `abc$def` or one containing backticks
// is taken literally and identically on macOS and Linux. This mirrors
// `node --env-file`/dotenv. Existing variables win, so a real env var or a
// unit's native Environment=/EnvironmentVariables entry is never clobbered.
// ponytail: plain env file; move to systemd LoadCredential=/launchd Keychain if a
// maintainer wants secrets kept out of a world-readable file.
export function loadServiceEnv(configPath: string, env: Record<string, string | undefined> = process.env): void {
  const file = serviceEnvFile(configPath);
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (!Object.hasOwn(env, key)) env[key] = value;
  }
}
