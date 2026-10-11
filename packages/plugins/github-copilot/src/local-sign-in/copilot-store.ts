import { homedir } from 'node:os';
import { join } from 'node:path';

import type { OAuthLocalSignIn } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { completeGitHubCopilotLogin } from '../github-api/login';
import type { GitHubAccountOptions, GitHubCopilotCredential } from '../github-api/types';

declare const __AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__: string;

export class CopilotSignInInvalidError extends Error {
  override readonly name = 'CopilotSignInInvalidError';

  constructor() {
    super('GitHub Copilot local sign-in is invalid or incomplete');
  }
}

export function copilotConfigDir(env: Record<string, string | undefined> = process.env): string {
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'github-copilot');
}

export function createCopilotLocalSignIn(
  input: { readonly dir?: () => string } = {},
): OAuthLocalSignIn<GitHubAccountOptions, GitHubCopilotCredential> {
  const dir = input.dir ?? copilotConfigDir;
  return {
    source: 'GitHub Copilot',
    detect: async () => {
      const configDir = dir();
      return (
        (await Bun.file(join(configDir, 'apps.json')).exists()) ||
        (await Bun.file(join(configDir, 'hosts.json')).exists())
      );
    },
    read: async (context, options) => {
      try {
        const host = options.deploymentType === 'enterprise' ? new URL(options.enterpriseURL).host : 'github.com';
        const githubToken = await readGitHubToken(dir(), host);
        if (githubToken === undefined) throw new CopilotSignInInvalidError();
        return await completeGitHubCopilotLogin(githubToken, options, context);
      } catch {
        // Filesystem, parsing, and upstream errors can carry host credentials or store contents.
        throw new CopilotSignInInvalidError();
      }
    },
  };
}

async function readGitHubToken(dir: string, host: string): Promise<string | undefined> {
  const apps = await readCopilotStore(join(dir, 'apps.json'));
  if (apps !== undefined) {
    const preferred = entryToken(apps[`${host}:${__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__}`]);
    if (preferred !== undefined) return preferred;
    for (const [key, entry] of Object.entries(apps)) {
      const separator = key.lastIndexOf(':');
      if (separator <= 0 || separator === key.length - 1 || key.slice(0, separator) !== host) continue;
      const token = entryToken(entry);
      if (token !== undefined) return token;
    }
  }
  const hosts = await readCopilotStore(join(dir, 'hosts.json'));
  return entryToken(hosts?.[host]);
}

async function readCopilotStore(path: string): Promise<Record<string, unknown> | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const raw: unknown = await file.json();
  if (!isPlainObject(raw)) throw new CopilotSignInInvalidError();
  return raw;
}

function entryToken(entry: unknown): string | undefined {
  if (!isPlainObject(entry)) return undefined;
  const token = entry['oauth_token'];
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}
