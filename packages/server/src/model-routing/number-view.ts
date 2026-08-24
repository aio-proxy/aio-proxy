import type { DashboardRoutingNumber } from '@aio-proxy/types';

export function routingNumberView(authored: number | undefined, effective: number): DashboardRoutingNumber {
  if (authored === undefined) return { effective, wasNormalized: false };
  return { authored, effective, wasNormalized: authored !== effective };
}

export function authoredNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
