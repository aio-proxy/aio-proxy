export type AgentAuthToken = {
  readonly accessToken: string;
  readonly expiresIn: number;
};

export type AgentAuthTokenFormat = 'raw' | 'json';

export function formatAgentToken(token: AgentAuthToken, format: AgentAuthTokenFormat): string {
  return format === 'raw'
    ? `${token.accessToken}\n`
    : `${JSON.stringify({ access_token: token.accessToken, expires_in: Math.floor(token.expiresIn) })}\n`;
}
