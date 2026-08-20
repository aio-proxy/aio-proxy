import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from 'node:crypto';

import { AgentInstallationTargetMismatchError, type AgentIdentityService } from '@aio-proxy/core';
import {
  AGENT_CLIENT_ID,
  type AgentAuthorizationDetails,
  type AgentDeviceCodeRequest,
  type AgentDeviceCodeResponse,
  type AgentOAuthError,
  type AgentTarget,
  type AgentTokenResponse,
} from '@aio-proxy/types';

const DEVICE_TTL_MS = 10 * 60_000;
const INITIAL_POLL_SECONDS = 5;
const CREDENTIAL_REPLAY_MS = 30_000;
const MAX_CHALLENGES = 256;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_SOURCES = 256;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class DeviceChallengeError extends Error {
  constructor(
    readonly status: 400 | 429,
    readonly code: 'invalid_client' | 'rate_limited' | 'capacity_exceeded',
  ) {
    super(code);
  }
}

type Challenge = {
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly clientId: string;
  readonly target: AgentTarget;
  readonly installationId: string;
  readonly adapterVersion: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  intervalSeconds: number;
  nextPollAt: number;
  issued?: AgentTokenResponse;
  issuedUntil?: number;
};

type PollInput = { readonly clientId: string; readonly deviceCode: string };
type PollResult =
  | { readonly ok: true; readonly token: AgentTokenResponse }
  | { readonly ok: false; readonly error: AgentOAuthError['error']; readonly interval?: number };
type RateBucket = { startedAt: number; count: number };
type ChallengeMaps = {
  readonly byDeviceCode: Map<string, Challenge>;
  readonly byUserCode: Map<string, Challenge>;
  readonly byDeviceId: Map<string, Challenge>;
  readonly byInstallation: Map<string, Challenge>;
};

export type DeviceChallengeStore = {
  readonly create: (input: AgentDeviceCodeRequest, source: string) => AgentDeviceCodeResponse;
  readonly resolve: (userCode: string, source: string) => AgentAuthorizationDetails;
  readonly approve: (deviceId: string, source: string) => 'approved' | 'denied' | 'expired' | 'consumed';
  readonly deny: (deviceId: string, source: string) => 'approved' | 'denied' | 'expired' | 'consumed';
  readonly poll: (input: PollInput, source: string) => PollResult;
};

type DeviceChallengeStoreInput = {
  readonly identity: Pick<AgentIdentityService, 'issueCredential'>;
  readonly verificationUri: string;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly randomUUID?: () => string;
};

const installationKey = (clientId: string, installationId: string): string => `${clientId}\0${installationId}`;

function checkRate(rates: Map<string, RateBucket>, source: string, timestamp: number): void {
  const current = rates.get(source);
  if (current === undefined || timestamp - current.startedAt >= RATE_WINDOW_MS) {
    for (const [key, bucket] of rates) {
      if (timestamp - bucket.startedAt >= RATE_WINDOW_MS) rates.delete(key);
    }
    if (!rates.has(source) && rates.size >= MAX_RATE_SOURCES) {
      throw new DeviceChallengeError(429, 'rate_limited');
    }
    rates.set(source, { startedAt: timestamp, count: 1 });
    return;
  }
  if (current.count >= RATE_LIMIT) throw new DeviceChallengeError(429, 'rate_limited');
  current.count += 1;
}

function uniqueDeviceCode(randomBytes: (size: number) => Uint8Array, byDeviceCode: Map<string, Challenge>): string {
  for (let attempt = 0; attempt <= MAX_CHALLENGES; attempt += 1) {
    const value = Buffer.from(randomBytes(32)).toString('base64url');
    if (!byDeviceCode.has(value)) return value;
  }
  throw new DeviceChallengeError(429, 'capacity_exceeded');
}

function uniqueUserCode(
  randomBytes: (size: number) => Uint8Array,
  byUserCode: Map<string, Challenge>,
): { readonly raw: string; readonly display: string } {
  for (let attempt = 0; attempt <= MAX_CHALLENGES; attempt += 1) {
    const bytes = randomBytes(8);
    let raw = '';
    for (let index = 0; index < 8; index += 1) {
      raw += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length]!;
    }
    if (!byUserCode.has(raw)) return { raw, display: `${raw.slice(0, 4)}-${raw.slice(4)}` };
  }
  throw new DeviceChallengeError(429, 'capacity_exceeded');
}

function releaseInstallationSlot(maps: ChallengeMaps, challenge: Challenge): void {
  const key = installationKey(challenge.clientId, challenge.installationId);
  if (maps.byInstallation.get(key) === challenge) maps.byInstallation.delete(key);
}

function deleteChallenge(maps: ChallengeMaps, challenge: Challenge): void {
  maps.byDeviceCode.delete(challenge.deviceCode);
  maps.byUserCode.delete(challenge.userCode.replace('-', ''));
  maps.byDeviceId.delete(challenge.deviceId);
  releaseInstallationSlot(maps, challenge);
}

function pruneExpired(maps: ChallengeMaps, timestamp: number): void {
  for (const challenge of maps.byDeviceId.values()) {
    const expired =
      challenge.status === 'consumed' ? challenge.issuedUntil! <= timestamp : challenge.expiresAt <= timestamp;
    if (expired) deleteChallenge(maps, challenge);
  }
}

function terminal(challenge: Challenge | undefined): AgentAuthorizationDetails {
  if (challenge === undefined) return { status: 'expired' };
  if (challenge.status !== 'pending') return { status: challenge.status };
  return {
    status: 'pending',
    deviceId: challenge.deviceId,
    target: challenge.target,
    installationId: challenge.installationId,
    adapterVersion: challenge.adapterVersion,
    expiresAt: new Date(challenge.expiresAt).toISOString(),
    permissions: ['catalog', 'inference'],
  };
}

function consumeApproved(
  identity: Pick<AgentIdentityService, 'issueCredential'>,
  maps: ChallengeMaps,
  challenge: Challenge,
  timestamp: number,
): PollResult {
  let issued;
  try {
    issued = identity.issueCredential({
      installationId: challenge.installationId,
      target: challenge.target,
      adapterVersion: challenge.adapterVersion,
    });
  } catch (error) {
    if (error instanceof AgentInstallationTargetMismatchError) return { ok: false, error: 'invalid_grant' };
    throw error;
  }
  challenge.issued = {
    token_type: 'Bearer',
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    expires_in: issued.expiresIn,
  };
  challenge.issuedUntil = timestamp + CREDENTIAL_REPLAY_MS;
  challenge.status = 'consumed';
  releaseInstallationSlot(maps, challenge);
  return { ok: true, token: challenge.issued };
}

export function createDeviceChallengeStore(input: DeviceChallengeStoreInput): DeviceChallengeStore {
  const now = input.now ?? Date.now;
  const randomBytes = input.randomBytes ?? nodeRandomBytes;
  const randomUUID = input.randomUUID ?? nodeRandomUUID;
  const maps: ChallengeMaps = {
    byDeviceCode: new Map(),
    byUserCode: new Map(),
    byDeviceId: new Map(),
    byInstallation: new Map(),
  };
  const createRates = new Map<string, RateBucket>();
  const resolveRates = new Map<string, RateBucket>();
  const decisionRates = new Map<string, RateBucket>();

  function create(request: AgentDeviceCodeRequest, source: string): AgentDeviceCodeResponse {
    const timestamp = now();
    pruneExpired(maps, timestamp);
    checkRate(createRates, source, timestamp);
    if (AGENT_CLIENT_ID[request.agent] !== request.client_id) {
      throw new DeviceChallengeError(400, 'invalid_client');
    }
    const key = installationKey(request.client_id, request.installation_id);
    const previous = maps.byInstallation.get(key);
    if (previous !== undefined) deleteChallenge(maps, previous);
    if (maps.byDeviceId.size >= MAX_CHALLENGES) throw new DeviceChallengeError(429, 'capacity_exceeded');

    const deviceCode = uniqueDeviceCode(randomBytes, maps.byDeviceCode);
    const userCode = uniqueUserCode(randomBytes, maps.byUserCode);
    const challenge: Challenge = {
      deviceId: randomUUID(),
      deviceCode,
      userCode: userCode.display,
      clientId: request.client_id,
      target: request.agent,
      installationId: request.installation_id,
      adapterVersion: request.adapter_version,
      createdAt: timestamp,
      expiresAt: timestamp + DEVICE_TTL_MS,
      status: 'pending',
      intervalSeconds: INITIAL_POLL_SECONDS,
      nextPollAt: timestamp + INITIAL_POLL_SECONDS * 1_000,
    };
    maps.byDeviceCode.set(deviceCode, challenge);
    maps.byUserCode.set(userCode.raw, challenge);
    maps.byDeviceId.set(challenge.deviceId, challenge);
    maps.byInstallation.set(key, challenge);
    return {
      device_code: deviceCode,
      user_code: userCode.display,
      verification_uri: input.verificationUri,
      verification_uri_complete: `${input.verificationUri}#code=${encodeURIComponent(userCode.display)}`,
      expires_in: 600,
      interval: INITIAL_POLL_SECONDS,
    };
  }

  function resolve(userCode: string, source: string): AgentAuthorizationDetails {
    const timestamp = now();
    checkRate(resolveRates, source, timestamp);
    pruneExpired(maps, timestamp);
    const normalized = userCode.toUpperCase().replaceAll(/[^A-HJ-NP-Z2-9]/gu, '');
    return terminal(normalized.length === 8 ? maps.byUserCode.get(normalized) : undefined);
  }

  function decide(
    deviceId: string,
    source: string,
    decision: 'approved' | 'denied',
  ): 'approved' | 'denied' | 'expired' | 'consumed' {
    const timestamp = now();
    checkRate(decisionRates, source, timestamp);
    pruneExpired(maps, timestamp);
    const challenge = maps.byDeviceId.get(deviceId);
    if (challenge === undefined) return 'expired';
    if (challenge.status === 'pending') challenge.status = decision;
    return challenge.status;
  }

  function poll(request: PollInput, _source: string): PollResult {
    const timestamp = now();
    pruneExpired(maps, timestamp);
    const challenge = maps.byDeviceCode.get(request.deviceCode);
    if (challenge === undefined) return { ok: false, error: 'expired_token' };
    if (challenge.clientId !== request.clientId) return { ok: false, error: 'invalid_client' };
    if (challenge.status === 'denied') return { ok: false, error: 'access_denied' };
    if (challenge.status === 'consumed') return { ok: true, token: challenge.issued! };
    if (challenge.status === 'pending' && timestamp < challenge.nextPollAt) {
      challenge.intervalSeconds += 5;
      challenge.nextPollAt = timestamp + challenge.intervalSeconds * 1_000;
      return { ok: false, error: 'slow_down', interval: challenge.intervalSeconds };
    }
    challenge.nextPollAt = timestamp + challenge.intervalSeconds * 1_000;
    if (challenge.status === 'pending') return { ok: false, error: 'authorization_pending' };
    return consumeApproved(input.identity, maps, challenge, timestamp);
  }

  return {
    create,
    resolve,
    approve: (deviceId, source) => decide(deviceId, source, 'approved'),
    deny: (deviceId, source) => decide(deviceId, source, 'denied'),
    poll,
  };
}
