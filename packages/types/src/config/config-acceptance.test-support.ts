export { apiProvider, providers } from '../../__tests__/schemas.test-support';

export const defaultServer = {
  host: '127.0.0.1',
  port: 9_317,
  apiKeys: [],
  requireApiKey: false,
  logging: { enabled: false, retentionDays: 3, level: 'info', captureMaxBytes: 67108864 },
  otel: { destinations: [] },
  retry: { retryAfterCapMs: 30_000 },
  requestBody: { maxBytes: 268435456 },
} as const;

export const defaultRouter = { modelContextAggregation: 'min', selection: 'weighted', models: {} } as const;
