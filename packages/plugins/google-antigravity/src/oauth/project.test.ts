import { expect, spyOn, test } from 'bun:test';

import { antigravityEndpoints } from '../runtime/endpoints';
import { initializeAntigravityProject } from './project';

test('routes load and onboarding to daily, and runtime operations through daily then sandbox', () => {
  expect(antigravityEndpoints({}, 'project-load')).toEqual(['https://daily-cloudcode-pa.googleapis.com']);
  expect(antigravityEndpoints({}, 'onboarding')).toEqual(['https://daily-cloudcode-pa.googleapis.com']);
  expect(antigravityEndpoints({}, 'discovery')).toEqual([
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ]);
  expect(antigravityEndpoints({}, 'inference', 'https://daily-cloudcode-pa.sandbox.googleapis.com')).toEqual([
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com',
  ]);
  expect(antigravityEndpoints({ baseURL: ' https://proxy.example.test/root/ ' }, 'inference')).toEqual([
    'https://proxy.example.test/root',
  ]);
});

test.each(['https://proxy.example.test/root?tenant=secret', 'https://proxy.example.test/root#fragment'])(
  'does not construct fixed endpoints from a base URL containing query or fragment',
  (baseURL) => {
    expect(() => antigravityEndpoints({ baseURL }, 'discovery')).toThrow('query or fragment');
  },
);

test('returns an existing project identity from loadCodeAssist', async () => {
  const requests: Request[] = [];
  const projectId = await initializeAntigravityProject(
    'access',
    {},
    {
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          project: { id: ' project-existing ' },
          currentTier: { id: 'free-tier' },
          paidTier: { id: 'standard-tier' },
        });
      },
      sleep: async () => {},
      signal: new AbortController().signal,
    },
  );

  expect(projectId).toBe('project-existing');
  expect(requests).toHaveLength(2);
  expect(requests[0]?.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  expect(requests[1]?.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  expect(await requests[0]?.clone().json()).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } });
  expect(await requests[1]?.clone().json()).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } });
});

test('reloads with the returned project when paidTier is absent', async () => {
  const requests: Request[] = [];
  const payloads = [
    { currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'project-123' },
    {
      currentTier: { id: 'free-tier' },
      paidTier: { id: 'standard-tier' },
      cloudaicompanionProject: 'project-123',
    },
    {
      currentTier: { id: 'free-tier' },
      paidTier: { id: 'standard-tier' },
      cloudaicompanionProject: 'project-123',
    },
  ];
  const projectId = await initializeAntigravityProject(
    'access',
    {},
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json(payloads[requests.length - 1]);
      },
      sleep: async () => {},
    },
  );

  expect(projectId).toBe('project-123');
  expect(requests).toHaveLength(3);
  expect(await requests[0]?.clone().json()).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } });
  expect(await requests[1]?.clone().json()).toEqual({
    cloudaicompanionProject: 'project-123',
    metadata: { ideType: 'ANTIGRAVITY' },
  });
  expect(await requests[2]?.clone().json()).toEqual({ metadata: { ideType: 'ANTIGRAVITY' } });
});

test('combines the caller signal with a 30-second timeout for load and onboarding', async () => {
  const timeoutMilliseconds: number[] = [];
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    timeoutMilliseconds.push(milliseconds);
    return new AbortController().signal;
  });
  const callerSignal = new AbortController().signal;
  const signals: Array<AbortSignal | null | undefined> = [];
  try {
    await initializeAntigravityProject(
      'access',
      {},
      {
        fetch: async (input, init) => {
          signals.push(init?.signal);
          const url = String(input);
          if (url.endsWith(':loadCodeAssist')) {
            if (signals.length === 1) return Response.json({ allowedTiers: [{ id: 'free-tier' }] });
            return Response.json({
              cloudaicompanionProject: 'project-1',
              currentTier: { id: 'free-tier' },
              paidTier: {},
            });
          }
          if (url.endsWith(':onboardUser')) {
            return Response.json({
              name: 'operations/op-1',
              done: true,
              response: { cloudaicompanionProject: 'project-1' },
            });
          }
          throw new Error(url);
        },
        sleep: async () => {},
        signal: callerSignal,
      },
    );
  } finally {
    timeout.mockRestore();
  }

  expect(timeoutMilliseconds).toEqual([30_000, 30_000, 30_000]);
  expect(signals).toHaveLength(3);
  for (const signal of signals) expect(signal).not.toBe(callerSignal);
});

test('onboards free-tier once and polls the long-running operation', async () => {
  const requests: Request[] = [];
  const sleeps: number[] = [];
  const projectId = await initializeAntigravityProject(
    'access',
    {},
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = request.url;
        if (url.endsWith(':loadCodeAssist')) {
          if (requests.some((item) => item.url.endsWith(':onboardUser'))) {
            return Response.json({
              cloudaicompanionProject: 'project-1',
              currentTier: { id: 'free-tier' },
              paidTier: {},
            });
          }
          return Response.json({ allowedTiers: [{ id: 'free-tier' }] });
        }
        if (url.endsWith(':onboardUser')) {
          return Response.json({ name: 'operations/op-1', done: false });
        }
        if (url.endsWith('/operations/op-1')) {
          return Response.json({
            name: 'operations/op-1',
            done: true,
            response: { cloudaicompanionProject: 'project-1' },
          });
        }
        throw new Error(url);
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  expect(projectId).toBe('project-1');
  expect(await requests[1]?.clone().json()).toEqual({
    tierId: 'free-tier',
    metadata: { ideType: 'ANTIGRAVITY' },
  });
  expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    'POST /v1internal:loadCodeAssist',
    'POST /v1internal:onboardUser',
    'GET /v1internal/operations/op-1',
    'POST /v1internal:loadCodeAssist',
  ]);
  expect(sleeps).toEqual([1_000]);
});

test('rejects an ineligible free-tier with the validation URL', async () => {
  await expect(
    initializeAntigravityProject(
      'access',
      {},
      {
        fetch: async () =>
          Response.json({
            ineligibleTiers: [
              {
                tierId: 'free-tier',
                reasonMessage: 'Verify your Google account',
                validationUrl: 'https://accounts.google.com/verify',
              },
            ],
          }),
        sleep: async () => {},
      },
    ),
  ).rejects.toThrow('Verify your Google account\nhttps://accounts.google.com/verify');
});

test('times out the onboard LRO after 30 seconds', async () => {
  let now = 0;
  await expect(
    initializeAntigravityProject(
      'access',
      {},
      {
        fetch: async (input) => {
          if (String(input).endsWith(':loadCodeAssist')) return Response.json({ allowedTiers: [{ id: 'free-tier' }] });
          return Response.json({ name: 'operations/op-1', done: false });
        },
        sleep: async () => {
          now = 30_000;
        },
        now: () => now,
      },
    ),
  ).rejects.toThrow('timed out after 30000ms');
});
