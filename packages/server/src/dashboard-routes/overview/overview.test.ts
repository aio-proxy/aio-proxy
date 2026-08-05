import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig } from '@aio-proxy/core';
import {
  DashboardOverviewActivityResponseSchema,
  DashboardOverviewDiagnosticsResponseSchema,
  DashboardOverviewResponseSchema,
} from '@aio-proxy/types';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createServerState } from '../../server-state';
import { createDashboardRoutes } from '../config';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

async function overviewRoutes() {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-overview-'));
  homes.push(home);
  const config = parseRuntimeConfig({
    providers: {
      first: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://first.example.test/v1',
        models: ['first-model'],
      },
      second: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://second.example.test/v1',
        models: ['second-model'],
      },
    },
  });
  const state = await createServerState({ config, dbHome: home, watchConfig: false });
  return { routes: createDashboardRoutes(state, disabledDashboardAuthentication), state };
}

describe('GET /overview', () => {
  test('returns only typed 90d range data with the configured provider count', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview?range=90d');
      const body = DashboardOverviewResponseSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ range: '90d', summary: { providerCount: 2 } });
      expect('providerHealth' in body).toBe(false);
      expect('topModelCosts' in body).toBe(false);
      expect('activity' in body).toBe(false);
    } finally {
      state.close();
    }
  });

  test('returns all-time diagnostics from an independent endpoint', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview/diagnostics');

      expect(response.status).toBe(200);
      expect(DashboardOverviewDiagnosticsResponseSchema.parse(await response.json())).toEqual({
        providerHealth: [],
        topModelCosts: [],
      });
    } finally {
      state.close();
    }
  });

  test('returns rolling activity from an independent endpoint', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview/activity');
      const body = DashboardOverviewActivityResponseSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(body.items).toBeDefined();
      expect(body).not.toHaveProperty('year');
      expect(body).not.toHaveProperty('days');
    } finally {
      state.close();
    }
  });

  test('ignores unknown query params on activity endpoint', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview/activity?year=2026');
      const body = DashboardOverviewActivityResponseSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(body.items).toBeDefined();
    } finally {
      state.close();
    }
  });

  test('rejects ranges outside the dashboard overview contract', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      expect((await routes.request('/overview?range=14d')).status).toBe(400);
    } finally {
      state.close();
    }
  });

  test('keeps the legacy 14d usage range valid', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/usage?range=14d&metric=cost&groupBy=model');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ range: '14d' });
    } finally {
      state.close();
    }
  });
});
