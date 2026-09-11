import { expect, test } from 'bun:test';
import { chmod, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentRuntimeError } from '@aio-proxy/agent-provider-runtime';
import { acquireFileLock } from '@aio-proxy/core';
import { AgentDeviceCodeResponseSchema, AgentTokenResponseSchema } from '@aio-proxy/types';

import { configureGrok, loadGrokPolicy, readGrokObservation, type GrokAuthObservation } from '../grok';
import { grokFixture } from '../grok/test-fixture';
import { grokAuth, GrokAuthError } from './grok-auth';
import type { GrokAuthDeps, GrokAuthInput, GrokTransport } from './types';

const EXTERNAL_MODEL = '\n[model.external]\nbase_url="https://outside.invalid/v1"\n';
const GROK_CONFIG_OVERLAY = JSON.stringify({
  endpoints: { models_base_url: 'https://outside.invalid/v1' },
});
const ORG_POLICY = '[endpoints]\nmodels_base_url = "https://outside.invalid/v1"\n';
const ALIAS_PIN = '[endpoints]\nmodels_endpoint = "https://outside.invalid/v1/models"\n';

async function authFixture() {
  const f = await grokFixture();
  const configured = await configureGrok(f.input, f.deps);
  const device = AgentDeviceCodeResponseSchema.parse({
    device_code: 'e'.repeat(43),
    user_code: 'ABCD-EFGH',
    verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
    expires_in: 600,
    interval: 5,
  });
  const tokens = AgentTokenResponseSchema.parse({
    token_type: 'Bearer',
    access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
    refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`,
    expires_in: 900,
  });
  const calls = { device: 0, poll: 0, refresh: 0 };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const input: GrokAuthInput = {
    root: f.root,
    installationId: configured.marker.installationId,
    adapterVersion: f.input.adapterVersion,
    expired: false,
  };
  const deps: GrokAuthDeps = {
    now: Date.now,
    policy: f.deps.policy,
    stdout: async (line) => {
      stdout.push(line);
    },
    stderr: (line) => {
      stderr.push(line);
    },
    transport: () => ({
      device: async () => {
        calls.device++;
        return device;
      },
      poll: async () => {
        calls.poll++;
        return tokens;
      },
      refresh: async () => {
        calls.refresh++;
        return tokens;
      },
    }),
  };
  return { ...f, configured, device, tokens, input, deps, calls, stdout, stderr };
}

const credentialPath = (root: string) => join(root, 'aio-proxy', 'credential.json');

const readCredentialFile = async (root: string) =>
  JSON.parse(await readFile(credentialPath(root), 'utf8')) as Record<string, unknown>;

const writeCredentialFile = async (root: string, value: Record<string, unknown>) => {
  await writeFile(credentialPath(root), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(credentialPath(root), 0o600);
};

const appendConfig = async (root: string, suffix: string) => {
  const configPath = join(root, 'config.toml');
  const text = await readFile(configPath, 'utf8');
  await writeFile(configPath, text + suffix);
  return configPath;
};

test('silent missing credentials throw login_required when the helper budget is nearly exhausted', async () => {
  const f = await authFixture();
  try {
    const started = Date.now();
    let advanced = false;
    await expect(
      grokAuth(
        { ...f.input, expired: true },
        {
          ...f.deps,
          now: () => {
            if (advanced) return started + 4_900;
            advanced = true;
            return started;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'login_required' });
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('silent auth never starts device flow when credentials are missing', async () => {
  const f = await authFixture();
  try {
    await expect(grokAuth({ ...f.input, expired: true }, f.deps)).rejects.toThrow(/login/);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('device login expiry starts when the token arrives', async () => {
  const f = await authFixture();
  try {
    let now = Date.now();
    await grokAuth(f.input, {
      ...f.deps,
      now: () => now,
      transport: () => ({
        device: async () => {
          f.calls.device++;
          return f.device;
        },
        poll: async () => {
          now += 120_000;
          f.calls.poll++;
          return f.tokens;
        },
        refresh: async () => {
          f.calls.refresh++;
          return f.tokens;
        },
      }),
    });
    const credential = await readCredentialFile(f.root);
    expect(credential.accessExpiresAt).toBe(now + 900_000);
    expect(JSON.parse(f.stdout[0]!).expires_in).toBe(900);
  } finally {
    await f.cleanup();
  }
});

test('refresh expiry starts when the token arrives', async () => {
  const f = await authFixture();
  try {
    let now = Date.now();
    const clockDeps = {
      ...f.deps,
      now: () => now,
      transport: () => ({
        device: async () => {
          f.calls.device++;
          return f.device;
        },
        poll: async () => {
          f.calls.poll++;
          return f.tokens;
        },
        refresh: async () => {
          now += 120_000;
          f.calls.refresh++;
          return f.tokens;
        },
      }),
    };
    await grokAuth(f.input, clockDeps);
    await grokAuth(f.input, clockDeps);
    const credential = await readCredentialFile(f.root);
    expect(credential.accessExpiresAt).toBe(now + 900_000);
    expect(JSON.parse(f.stdout[1]!).expires_in).toBe(900);
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 1 });
  } finally {
    await f.cleanup();
  }
});

test('normal login validates apparently unexpired credentials through refresh', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await grokAuth(f.input, f.deps);
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 1 });
    expect(Object.keys(JSON.parse(f.stdout[1]!))).toEqual(['access_token', 'expires_in']);
    expect(f.stdout.every((line) => line.endsWith('\n'))).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('auth rejects a newly added external model (silent=%s)', async (expired) => {
  const f = await authFixture();
  try {
    const configPath = join(f.root, 'config.toml');
    const text = await readFile(configPath, 'utf8');
    await writeFile(configPath, text + '\n[model.external]\nbase_url="https://outside.invalid/v1"\n');
    await expect(grokAuth({ ...f.input, expired }, f.deps)).rejects.toThrow(/routing conflict/);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
    expect(await readFile(configPath, 'utf8')).toContain('https://outside.invalid/v1');
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('auth rejects a GROK_CONFIG overlay after configure (silent=%s)', async (expired) => {
  const f = await authFixture();
  try {
    await expect(
      grokAuth(
        { ...f.input, expired },
        {
          ...f.deps,
          policy: async () => ({
            env: {},
            sources: [{ path: 'GROK_CONFIG', kind: 'json', text: GROK_CONFIG_OVERLAY }],
          }),
        },
      ),
    ).rejects.toThrow(/routing conflict/);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('auth rejects an organization policy address after configure (silent=%s)', async (expired) => {
  const f = await authFixture();
  try {
    await expect(
      grokAuth(
        { ...f.input, expired },
        {
          ...f.deps,
          policy: async () => ({
            env: {},
            sources: [{ path: join(f.root, 'requirements.toml'), kind: 'toml', text: ORG_POLICY }],
          }),
        },
      ),
    ).rejects.toThrow(/routing conflict/);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('auth rejects an unverifiable policy after configure (silent=%s)', async (expired) => {
  const f = await authFixture();
  try {
    await expect(
      grokAuth(
        { ...f.input, expired },
        {
          ...f.deps,
          policy: async () => {
            throw new Error('Grok visible policy unverifiable');
          },
        },
      ),
    ).rejects.toThrow(/unverifiable/);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('auth rejects a user-added catalog alias after configure (silent=%s)', async (expired) => {
  const f = await authFixture();
  try {
    const configPath = join(f.root, 'config.toml');
    const text = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      text.replace(
        /models_list_url = "[^"]+"/,
        (match) => `${match}\nmodels_endpoint = "https://outside.invalid/v1/models"`,
      ),
    );
    await expect(grokAuth({ ...f.input, expired }, f.deps)).rejects.toThrow(/routing conflict/);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('auth rejects a managed alias pin after configure (silent=%s)', async (expired) => {
  const f = await authFixture();
  try {
    await writeFile(join(f.root, 'requirements.toml'), ALIAS_PIN, { mode: 0o600 });
    await expect(grokAuth({ ...f.input, expired }, { ...f.deps, policy: loadGrokPolicy })).rejects.toThrow(
      /routing conflict/,
    );
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('auth allows a same-origin model added after configure', async () => {
  const f = await authFixture();
  try {
    await appendConfig(f.root, '\n[model.local]\nbase_url="http://127.0.0.1:9317/v1"\n');
    await grokAuth(f.input, f.deps);
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 0 });
    expect(f.stdout).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test('auth allows unrelated UI added after configure', async () => {
  const f = await authFixture();
  try {
    await appendConfig(f.root, '\n[ui]\nfont_size=14\n');
    await grokAuth(f.input, f.deps);
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 0 });
    expect(JSON.parse(f.stdout[0]!).access_token).toBe(f.tokens.access_token);
    expect(f.stderr.some((line) => line.includes(f.device.verification_uri_complete))).toBe(true);
    expect(f.stdout.join('')).not.toContain(f.tokens.refresh_token);
    expect(f.stdout.join('')).not.toContain('refresh');
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])(
  'auth reports routing conflict before decoding a type-wrong credential (silent=%s)',
  async (expired) => {
    const f = await authFixture();
    try {
      await writeCredentialFile(f.root, {
        format: 1,
        agent: 'grok',
        installationId: f.input.installationId,
        endpoint: f.configured.marker.endpoint,
        revision: 4,
        status: 'ready',
        accessToken: 123,
        refreshToken: false,
        accessExpiresAt: Date.now() + 60_000,
        deliveredBy: '22222222-2222-4222-8222-222222222222',
      });
      const configPath = await appendConfig(f.root, EXTERNAL_MODEL);
      await expect(grokAuth({ ...f.input, expired }, f.deps)).rejects.toThrow(/routing conflict/);
      expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
      expect(f.stdout).toEqual([]);
      expect(await readFile(configPath, 'utf8')).toContain('https://outside.invalid/v1');
    } finally {
      await f.cleanup();
    }
  },
);

const REFRESHED = AgentTokenResponseSchema.parse({
  token_type: 'Bearer',
  access_token: `aio_agent_at_v1_${'c'.repeat(43)}`,
  refresh_token: `aio_agent_rt_v1_${'d'.repeat(43)}`,
  expires_in: 900,
});

const countingTransport = (
  f: Awaited<ReturnType<typeof authFixture>>,
  overrides: Partial<GrokTransport> = {},
): GrokTransport => ({
  device: async () => {
    f.calls.device++;
    return f.device;
  },
  poll: async () => {
    f.calls.poll++;
    return f.tokens;
  },
  refresh: async () => {
    f.calls.refresh++;
    return REFRESHED;
  },
  ...overrides,
});

test('auth reuse with a later routing conflict produces no stdout', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const current = await readCredentialFile(f.root);
    const lock = await acquireFileLock(join(f.root, '.aio-proxy.lock'), { deadline: Date.now() + 5_000 });
    const seen = Promise.withResolvers<void>();
    try {
      await writeCredentialFile(f.root, { ...current, deliveredBy: lock.owner });
      let checks = 0;
      const pending = grokAuth(f.input, {
        ...f.deps,
        policy: async () => {
          checks += 1;
          if (checks === 1) return { env: {}, sources: [] };
          return { env: {}, sources: [{ path: 'GROK_CONFIG', kind: 'json', text: GROK_CONFIG_OVERLAY }] };
        },
        readObservation: async (root, id, budget) => {
          const result = await readGrokObservation(root, id, budget);
          seen.resolve();
          return result;
        },
      });
      await seen.promise;
      await lock.release();
      await expect(pending).rejects.toThrow(/routing conflict/);
      expect(f.calls.refresh).toBe(0);
      expect(f.stdout).toHaveLength(1);
    } finally {
      await lock.release().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test('final routing check after a refresh keeps the new refresh token without stdout', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        transport: () =>
          countingTransport(f, {
            refresh: async () => {
              f.calls.refresh++;
              await appendConfig(f.root, EXTERNAL_MODEL);
              return REFRESHED;
            },
          }),
      }),
    ).rejects.toThrow(/routing conflict/);
    expect(f.stdout).toHaveLength(1);
    expect((await readCredentialFile(f.root)).refreshToken).toBe(REFRESHED.refresh_token);
  } finally {
    await f.cleanup();
  }
});

test('final routing check after a policy overlay during refresh keeps the new refresh token', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    let sources: Array<{ path: string; kind: 'json' | 'toml'; text: string }> = [];
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        policy: async () => ({ env: {}, sources }),
        transport: () =>
          countingTransport(f, {
            refresh: async () => {
              f.calls.refresh++;
              sources = [{ path: 'GROK_CONFIG', kind: 'json', text: GROK_CONFIG_OVERLAY }];
              return REFRESHED;
            },
          }),
      }),
    ).rejects.toThrow(/routing conflict/);
    expect(f.stdout).toHaveLength(1);
    expect((await readCredentialFile(f.root)).refreshToken).toBe(REFRESHED.refresh_token);
  } finally {
    await f.cleanup();
  }
});

test('a waiting helper reuses a newly delivered revision', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = grokAuth(f.input, {
      ...f.deps,
      transport: () =>
        countingTransport(f, {
          refresh: async () => {
            f.calls.refresh++;
            entered.resolve();
            await release.promise;
            return REFRESHED;
          },
        }),
    });
    await entered.promise;
    const seen = Promise.withResolvers<GrokAuthObservation>();
    const second = grokAuth(f.input, {
      ...f.deps,
      readObservation: async (root, id, budget) => {
        const result = await readGrokObservation(root, id, budget);
        seen.resolve(result);
        return result;
      },
    });
    expect((await seen.promise).lockOwner).toBeDefined();
    release.resolve();
    await Promise.all([first, second]);
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 1 });
    expect(f.stdout.map((line) => JSON.parse(line).access_token)).toEqual([
      f.tokens.access_token,
      REFRESHED.access_token,
      REFRESHED.access_token,
    ]);
  } finally {
    await f.cleanup();
  }
});

test('silent overlapping helper refreshes instead of reusing the observed access token', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const current = await readCredentialFile(f.root);
    const oldAccess = current.accessToken;
    const lock = await acquireFileLock(join(f.root, '.aio-proxy.lock'), { deadline: Date.now() + 5_000 });
    const seen = Promise.withResolvers<GrokAuthObservation>();
    try {
      await writeCredentialFile(f.root, { ...current, deliveredBy: lock.owner });
      const pending = grokAuth(
        { ...f.input, expired: true },
        {
          ...f.deps,
          transport: () => countingTransport(f),
          readObservation: async (root, id, budget) => {
            const result = await readGrokObservation(root, id, budget);
            seen.resolve(result);
            return result;
          },
        },
      );
      const snap = await seen.promise;
      expect(snap.lockOwner).toBe(lock.owner);
      expect(snap.deliveredBy).toBe(lock.owner);
      expect(snap.revision).toBe(current.revision);
      await lock.release();
      await pending;
      expect(f.calls.refresh).toBe(1);
      expect(JSON.parse(f.stdout[1]!).access_token).toBe(REFRESHED.access_token);
      expect(JSON.parse(f.stdout[1]!).access_token).not.toBe(oldAccess);
    } finally {
      await lock.release().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test('an overlapping lock owner reuses the same revision', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const current = await readCredentialFile(f.root);
    const lock = await acquireFileLock(join(f.root, '.aio-proxy.lock'), { deadline: Date.now() + 5_000 });
    const seen = Promise.withResolvers<GrokAuthObservation>();
    try {
      await writeCredentialFile(f.root, { ...current, deliveredBy: lock.owner });
      const pending = grokAuth(f.input, {
        ...f.deps,
        readObservation: async (root, id, budget) => {
          const result = await readGrokObservation(root, id, budget);
          seen.resolve(result);
          return result;
        },
      });
      const snap = await seen.promise;
      expect(snap.lockOwner).toBe(lock.owner);
      expect(snap.deliveredBy).toBe(lock.owner);
      await lock.release();
      await pending;
      expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 0 });
      expect(f.stdout).toHaveLength(2);
    } finally {
      await lock.release().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test('an independent helper after lock release refreshes instead of reusing', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await grokAuth(f.input, f.deps);
    await grokAuth(f.input, f.deps);
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 2 });
  } finally {
    await f.cleanup();
  }
});

test('an overlapping helper does not reuse an access token with under one second remaining', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const current = await readCredentialFile(f.root);
    const lock = await acquireFileLock(join(f.root, '.aio-proxy.lock'), { deadline: Date.now() + 5_000 });
    const seen = Promise.withResolvers<void>();
    try {
      await writeCredentialFile(f.root, {
        ...current,
        deliveredBy: lock.owner,
        accessExpiresAt: Date.now() + 500,
      });
      const pending = grokAuth(f.input, {
        ...f.deps,
        transport: () => countingTransport(f),
        readObservation: async (root, id, budget) => {
          const result = await readGrokObservation(root, id, budget);
          seen.resolve();
          return result;
        },
      });
      await seen.promise;
      await lock.release();
      await pending;
      expect(f.calls.refresh).toBe(1);
      expect(JSON.parse(f.stdout[1]!).access_token).toBe(REFRESHED.access_token);
    } finally {
      await lock.release().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test('a remaining lifetime under one second is not written to stdout', async () => {
  const f = await authFixture();
  try {
    let now = Date.now();
    await grokAuth(f.input, { ...f.deps, now: () => now });
    let refreshReturned = false;
    let nowCallsAfterRefresh = 0;
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        now: () => {
          if (!refreshReturned) return now;
          nowCallsAfterRefresh++;
          return nowCallsAfterRefresh === 1 ? now : now + 900_000;
        },
        transport: () =>
          countingTransport(f, {
            refresh: async () => {
              f.calls.refresh++;
              refreshReturned = true;
              return REFRESHED;
            },
          }),
      }),
    ).rejects.toThrow(/login/);
    expect(f.stdout).toHaveLength(1);
    expect((await readCredentialFile(f.root)).refreshToken).toBe(REFRESHED.refresh_token);
  } finally {
    await f.cleanup();
  }
});

test('stdout callback failure keeps the saved refresh token and is not a successful login', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        transport: () => countingTransport(f),
        stdout: async (line) => {
          f.stdout.push(line);
          throw new Error('broken pipe');
        },
      }),
    ).rejects.toThrow(/broken pipe/);
    expect((await readCredentialFile(f.root)).refreshToken).toBe(REFRESHED.refresh_token);
    expect(f.stdout).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test('invalid_grant on a normal helper starts device login', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await grokAuth(f.input, {
      ...f.deps,
      transport: () =>
        countingTransport(f, {
          poll: async () => {
            f.calls.poll++;
            return REFRESHED;
          },
          refresh: async () => {
            f.calls.refresh++;
            throw new AgentRuntimeError('invalid_grant');
          },
        }),
    });
    expect(f.calls).toEqual({ device: 2, poll: 2, refresh: 1 });
    expect(JSON.parse(f.stdout[1]!).access_token).toBe(REFRESHED.access_token);
  } finally {
    await f.cleanup();
  }
});

test('a network refresh failure keeps the refresh token and skips device login', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const before = await readCredentialFile(f.root);
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        transport: () =>
          countingTransport(f, {
            refresh: async () => {
              f.calls.refresh++;
              throw new AgentRuntimeError('network');
            },
          }),
      }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(f.calls.device).toBe(1);
    const after = await readCredentialFile(f.root);
    expect(after.refreshToken).toBe(before.refreshToken);
    expect(after.status).toBe('ready');
    expect(f.stdout).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test('a delayed retry after a network refresh failure still uses the refresh token', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const before = await readCredentialFile(f.root);
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        transport: () =>
          countingTransport(f, {
            refresh: async () => {
              f.calls.refresh++;
              throw new AgentRuntimeError('network');
            },
          }),
      }),
    ).rejects.toMatchObject({ code: 'network' });
    const later = Date.now() + 31_000;
    await grokAuth(f.input, {
      ...f.deps,
      now: () => later,
      transport: () => countingTransport(f),
    });
    expect(f.calls.device).toBe(1);
    expect(f.calls.refresh).toBe(2);
    expect((await readCredentialFile(f.root)).refreshToken).toBe(REFRESHED.refresh_token);
    expect(before.refreshToken).not.toBe(REFRESHED.refresh_token);
  } finally {
    await f.cleanup();
  }
});

test('an HTTP 500 refresh failure keeps the refresh token and skips device login', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        transport: () =>
          countingTransport(f, {
            refresh: async () => {
              f.calls.refresh++;
              throw new AgentRuntimeError('invalid_response');
            },
          }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.calls.device).toBe(1);
    expect((await readCredentialFile(f.root)).status).toBe('refreshing');
    expect(f.stdout).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test('silent invalid_grant does not start device login or return the old access token', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await expect(
      grokAuth(
        { ...f.input, expired: true },
        {
          ...f.deps,
          transport: () =>
            countingTransport(f, {
              refresh: async () => {
                f.calls.refresh++;
                throw new AgentRuntimeError('invalid_grant');
              },
            }),
        },
      ),
    ).rejects.toBeInstanceOf(GrokAuthError);
    expect(f.calls.device).toBe(1);
    expect(f.stdout).toHaveLength(1);
    expect(f.stdout.join('')).not.toContain(f.tokens.refresh_token);
  } finally {
    await f.cleanup();
  }
});

test('device denial and expiry leave no token on stdout', async () => {
  const f = await authFixture();
  try {
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        transport: () =>
          countingTransport(f, {
            poll: async () => {
              f.calls.poll++;
              throw new AgentRuntimeError('access_denied');
            },
          }),
      }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(f.stdout).toEqual([]);
    expect(await Bun.file(credentialPath(f.root)).exists()).toBe(false);
    await expect(
      grokAuth(f.input, {
        ...f.deps,
        transport: () =>
          countingTransport(f, {
            poll: async () => {
              f.calls.poll++;
              throw new AgentRuntimeError('expired_token');
            },
          }),
      }),
    ).rejects.toMatchObject({ code: 'expired_token' });
    expect(f.stdout).toEqual([]);
    expect(await Bun.file(credentialPath(f.root)).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test('readGrokObservation omits tokens and treats a missing credential as optional lock metadata', async () => {
  const f = await authFixture();
  try {
    const budget = { deadline: Date.now() + 5_000, signal: AbortSignal.timeout(5_000) };
    expect(await readGrokObservation(f.root, f.input.installationId, budget)).toEqual({});
    await grokAuth(f.input, f.deps);
    const observed = await readGrokObservation(f.root, f.input.installationId, budget);
    expect(observed.revision).toBe(1);
    expect(observed).not.toHaveProperty('accessToken');
    expect(observed).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(observed)).not.toContain(f.tokens.access_token);
    expect(JSON.stringify(observed)).not.toContain(f.tokens.refresh_token);
  } finally {
    await f.cleanup();
  }
});

test('readGrokObservation retries while the lock record is still being written', async () => {
  const f = await authFixture();
  try {
    const lockPath = join(f.root, '.aio-proxy.lock');
    await writeFile(lockPath, '', { mode: 0o600 });
    await chmod(lockPath, 0o600);
    const budget = { deadline: Date.now() + 2_000, signal: AbortSignal.timeout(2_000) };
    const pending = readGrokObservation(f.root, f.input.installationId, budget);
    await Bun.sleep(80);
    const identity = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(process.pid)], { stdout: 'pipe' });
    const starttime = (await new Response(identity.stdout).text()).trim();
    expect(await identity.exited).toBe(0);
    expect(starttime.length).toBeGreaterThan(0);
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        owner: 'concurrent-writer',
        createdAt: Date.now(),
        starttime,
      }),
      { mode: 0o600 },
    );
    await chmod(lockPath, 0o600);
    await expect(pending).resolves.toEqual({ lockOwner: 'concurrent-writer' });
  } finally {
    await f.cleanup();
  }
});

test('readGrokObservation treats an aged empty lock as no owner without waiting out the budget', async () => {
  const f = await authFixture();
  try {
    const lockPath = join(f.root, '.aio-proxy.lock');
    await writeFile(lockPath, '', { mode: 0o600 });
    await chmod(lockPath, 0o600);
    const aged = new Date(Date.now() - 1_000);
    await utimes(lockPath, aged, aged);
    const started = Date.now();
    const budget = { deadline: Date.now() + 2_000, signal: AbortSignal.timeout(2_000) };
    await expect(readGrokObservation(f.root, f.input.installationId, budget)).resolves.toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    await f.cleanup();
  }
});

test('readGrokObservation rejects corrupt and unknown credentials', async () => {
  const f = await authFixture();
  try {
    const budget = { deadline: Date.now() + 5_000, signal: AbortSignal.timeout(5_000) };
    await writeFile(credentialPath(f.root), '{nope', { mode: 0o600 });
    await chmod(credentialPath(f.root), 0o600);
    await expect(readGrokObservation(f.root, f.input.installationId, budget)).rejects.toThrow(/invalid/);
    await writeCredentialFile(f.root, {
      format: 2,
      agent: 'grok',
      installationId: f.input.installationId,
      revision: 1,
    });
    await expect(readGrokObservation(f.root, f.input.installationId, budget)).rejects.toThrow(/invalid/);
  } finally {
    await f.cleanup();
  }
});

test('network transport uses a deadline 250ms earlier than the helper budget', async () => {
  const f = await authFixture();
  try {
    const started = Date.now();
    let networkDeadline: number | undefined;
    await grokAuth(f.input, {
      ...f.deps,
      now: () => started,
      transport: (_marker, budget) => {
        networkDeadline = budget.deadline;
        return countingTransport(f);
      },
    });
    expect(networkDeadline).toBe(started + 240_000 - 250);
  } finally {
    await f.cleanup();
  }
});

test('a recoverable refresh journal retries without a device flow', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const current = await readCredentialFile(f.root);
    const startedAt = Date.now();
    await writeCredentialFile(f.root, { ...current, status: 'refreshing', refreshStartedAt: startedAt });
    await grokAuth(f.input, {
      ...f.deps,
      now: () => startedAt + 1_000,
      transport: () => countingTransport(f),
    });
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 1 });
    expect((await readCredentialFile(f.root)).refreshToken).toBe(REFRESHED.refresh_token);
  } finally {
    await f.cleanup();
  }
});

test('an expired refresh journal is persisted as needs_login for silent auth', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    const current = await readCredentialFile(f.root);
    await writeCredentialFile(f.root, {
      ...current,
      status: 'refreshing',
      refreshStartedAt: Date.now() - 31_000,
    });
    await expect(grokAuth({ ...f.input, expired: true }, f.deps)).rejects.toThrow(/login/);
    expect(f.calls.device).toBe(1);
    expect(f.calls.refresh).toBe(0);
    expect((await readCredentialFile(f.root)).status).toBe('needs_login');
    expect(f.stdout).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test('silent policy gate shares the five second budget', async () => {
  const f = await authFixture();
  try {
    const began = Date.now();
    await expect(
      grokAuth(
        { ...f.input, expired: true },
        {
          ...f.deps,
          policy: async (_root, budget) =>
            new Promise<never>((_, reject) => {
              const signal = budget?.signal;
              if (signal === undefined) return;
              const onAbort = () => reject(signal.reason);
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            }),
        },
      ),
    ).rejects.toThrow();
    expect(Date.now() - began).toBeLessThan(8_000);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 15_000);
