import type { AgentDeviceCodeResponse, AgentTokenResponse } from '@aio-proxy/types';

import type { GrokAuthObservation, GrokDeadline, GrokDeps, GrokMarker } from '../grok';

export type GrokCredential = {
  readonly format: 1;
  readonly agent: 'grok';
  readonly installationId: string;
  readonly endpoint: string;
  readonly revision: number;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly deliveredBy?: string; // 最近成功输出本revision的锁owner
  readonly status: 'ready' | 'refreshing' | 'needs_login';
  readonly refreshStartedAt?: number;
};

export type GrokTransport = {
  device(marker: GrokMarker): Promise<AgentDeviceCodeResponse>;
  poll(marker: GrokMarker, device: AgentDeviceCodeResponse): Promise<AgentTokenResponse>;
  refresh(marker: GrokMarker, refreshToken: string): Promise<AgentTokenResponse>;
};

export type GrokAuthInput = {
  readonly root: string;
  readonly installationId: string;
  readonly adapterVersion: string;
  readonly expired: boolean;
};

export type GrokAuthDeps = {
  readonly now: () => number;
  readonly policy: GrokDeps['policy'];
  readonly readObservation?: (
    root: string,
    installationId: string,
    budget: GrokDeadline,
  ) => Promise<GrokAuthObservation>;
  readonly transport: (marker: GrokMarker, budget: GrokDeadline) => GrokTransport;
  readonly stdout: (line: string) => Promise<void>;
  readonly stderr: (line: string) => void;
};
