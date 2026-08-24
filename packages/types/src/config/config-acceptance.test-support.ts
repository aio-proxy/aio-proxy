export { apiProvider, providers } from '../../__tests__/schemas.test-support';

export const defaultServer = {
  host: '127.0.0.1',
  port: 9_317,
  apiKeys: [],
  logging: { enabled: false, retentionDays: 3, level: 'info' },
  retry: { retryAfterCapMs: 30_000 },
} as const;

export const defaultRouter = { modelContextAggregation: 'min', models: {} } as const;
