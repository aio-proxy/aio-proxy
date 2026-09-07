declare const __AIO_PROXY_CLAUDE_CLIENT_ID__: string;

export const CLAUDE_CLIENT_ID = __AIO_PROXY_CLAUDE_CLIENT_ID__;
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
export const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const CLAUDE_BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap';
export const CLAUDE_API_BASE_URL = 'https://api.anthropic.com/v1';
export const CLAUDE_SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_REFRESH_USER_AGENT = 'anthropic-sdk-typescript/0.112.1 userOAuthProvider';
export const CLAUDE_BOOTSTRAP_USER_AGENT = 'claude-code/2.1.246';
export const CLAUDE_BOOTSTRAP_MODEL = 'claude-opus-4-8';
export const CLAUDE_LOOPBACK = {
  hostname: 'localhost',
  port: 54545,
  path: '/callback',
} as const;
