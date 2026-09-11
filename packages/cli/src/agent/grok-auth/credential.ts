import type { AgentTokenResponse } from '@aio-proxy/types';
import { z } from 'zod';

import type { GrokContext, GrokMarker } from '../grok';
import type { GrokCredential } from './types';

const revisionSchema = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0);
const BindingSchema = {
  format: z.literal(1),
  agent: z.literal('grok'),
  installationId: z.uuid(),
  endpoint: z.string(),
  revision: revisionSchema,
} as const;

const GrokCredentialSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...BindingSchema,
    status: z.literal('ready'),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    accessExpiresAt: z.number().finite(),
    deliveredBy: z.uuid().optional(),
  }),
  z.strictObject({
    ...BindingSchema,
    status: z.literal('refreshing'),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    accessExpiresAt: z.number().finite(),
    deliveredBy: z.uuid().optional(),
    refreshStartedAt: z.number().finite().positive(),
  }),
  z.strictObject({
    ...BindingSchema,
    status: z.literal('needs_login'),
    accessToken: z.literal(''),
    refreshToken: z.literal(''),
    accessExpiresAt: z.literal(0),
  }),
]);

export function parseGrokCredential(raw: unknown, marker: GrokMarker): GrokCredential {
  const parsed = GrokCredentialSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Grok credential invalid');
  if (
    parsed.data.agent !== marker.agent ||
    parsed.data.installationId !== marker.installationId ||
    parsed.data.endpoint !== marker.endpoint
  ) {
    throw new Error('Grok credential binding mismatch');
  }
  return parsed.data;
}

export async function saveGrokToken(
  context: GrokContext,
  previous: GrokCredential | undefined,
  token: AgentTokenResponse,
  requestStartedAt: number,
): Promise<GrokCredential> {
  const saved: GrokCredential = {
    format: 1,
    agent: 'grok',
    installationId: context.marker.installationId,
    endpoint: context.marker.endpoint,
    revision: (previous?.revision ?? 0) + 1,
    status: 'ready',
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessExpiresAt: requestStartedAt + token.expires_in * 1_000,
  };
  await context.writeCredential(saved);
  return saved;
}

export async function beginGrokRefresh(
  context: GrokContext,
  credential: GrokCredential,
  now: number,
): Promise<GrokCredential> {
  let refreshStartedAt = now;
  if (credential.status === 'refreshing') {
    if (credential.refreshStartedAt === undefined) throw new Error('Grok credential invalid');
    refreshStartedAt = credential.refreshStartedAt;
  }
  const saved: GrokCredential = {
    format: 1,
    agent: 'grok',
    installationId: credential.installationId,
    endpoint: credential.endpoint,
    revision: credential.revision,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    accessExpiresAt: credential.accessExpiresAt,
    status: 'refreshing',
    refreshStartedAt,
    ...(credential.deliveredBy === undefined ? {} : { deliveredBy: credential.deliveredBy }),
  };
  await context.writeCredential(saved);
  return saved;
}

export function grokRefreshRecoverable(credential: GrokCredential, now: number): boolean {
  const started = credential.refreshStartedAt;
  return credential.status === 'refreshing' && started !== undefined && now >= started && now - started < 30_000;
}
