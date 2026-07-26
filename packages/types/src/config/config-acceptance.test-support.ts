export { apiProvider, providers } from '../../__tests__/schemas.test-support';

export const defaultServer = {
  host: '127.0.0.1',
  port: 22_078,
  logging: { enabled: false, retentionDays: 14, level: 'info' },
} as const;
