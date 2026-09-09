import { expect, test } from 'bun:test';

import { twoServerSyncAcceptancePlugin, type TwoServerSyncFixture, withTwoServerSyncFixtures } from './test-support';

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error(message);
}

function cloudText(fixture: TwoServerSyncFixture): string {
  return [...fixture.backend.readAll().values()].map((value) => new TextDecoder().decode(value.value)).join('\n');
}

function cloudEntityVersions(fixture: TwoServerSyncFixture): Map<string, string> {
  return new Map(
    [...fixture.backend.readAll()]
      .filter(([key]) => key !== 's/v1/default/space')
      .map(([key, value]) => [key, value.version] as const),
  );
}

async function setProvider(
  server: TwoServerSyncFixture['a'],
  providerId: string,
  marker: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await server.state.configStore.mutateConfig((current) => ({
    ...current,
    providers: {
      ...(current['providers'] as Record<string, unknown>),
      [providerId]: {
        kind: 'api',
        protocol: 'openai-compatible',
        apiKey: marker,
        baseURL: 'https://work.example.test/v1',
        ...extra,
      },
    },
  }));
}

test('committed export has no echo; discovery and purge leave independent local copies', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    const { a, b } = fixture;
    expect(a.state.sync).toBeDefined();
    expect(b.state.sync).toBeDefined();
    expect(
      a.state.pluginControlPlane.summaries().some((plugin) => plugin.packageName === twoServerSyncAcceptancePlugin),
    ).toBe(true);

    await setProvider(a, 'work', a.providerMarker);
    await a.reconcile();
    const providerPreview = await a.state.sync!.preview({ kind: 'join', providerId: 'work' });
    await a.state.sync!.apply({
      previewId: providerPreview.previewId,
      decisions: providerPreview.rows.map((row) => ({ objectId: row.objectId, choice: 'local' as const })),
    });
    const edit = await a.state.pluginControlPlane.editView(twoServerSyncAcceptancePlugin);
    await a.state.pluginControlPlane.updateOptions({
      packageName: twoServerSyncAcceptancePlugin,
      revision: edit.revision,
      publicValues: { endpoint: 'https://plugin.example.test' },
      secretValues: { token: a.pluginMarker },
      clearSecretKeys: [],
    });
    await a.reconcile();

    await waitUntil(
      () => cloudText(fixture).includes(a.providerMarker) && cloudText(fixture).includes(a.pluginMarker),
      'the server did not publish the selected Provider and plugin records',
    );
    const beforeRemoteImport = cloudEntityVersions(fixture);

    await fixture.restart('a');
    await fixture.restart('b');
    await fixture.a.reconcile();
    await fixture.b.reconcile();
    await waitUntil(
      () => fixture.b.state.currentConfig().providers.some((provider) => provider.id === 'work'),
      'the second server did not activate the discovered Provider',
    );
    const importedPlugin = await fixture.b.state.pluginControlPlane.editView(twoServerSyncAcceptancePlugin);
    expect(importedPlugin.form).toContainEqual(
      expect.objectContaining({ type: 'secret', key: 'token', configured: true }),
    );
    expect(JSON.stringify(importedPlugin)).not.toContain(a.pluginMarker);
    await Bun.sleep(50);
    expect(cloudEntityVersions(fixture)).toEqual(beforeRemoteImport);

    await fixture.b.state.sync!.setRange('work', false);
    await fixture.restart('b');
    await fixture.b.reconcile();
    const purge = await fixture.a.state.sync!.preview({ kind: 'purge', scope: 'provider', objectId: 'work' });
    await fixture.a.state.sync!.apply({ previewId: purge.previewId, decisions: [] });
    await fixture.a.reconcile();
    await fixture.restart('a');
    await fixture.restart('b');
    await fixture.a.reconcile();
    await fixture.b.reconcile();
    await waitUntil(() => !cloudText(fixture).includes(a.providerMarker), 'purge left Provider bytes in the cloud');

    expect(fixture.b.state.currentConfig().providers.some((provider) => provider.id === 'work')).toBe(true);
    expect(cloudText(fixture).includes(a.pluginMarker)).toBe(true);
  });
}, 30_000);

test('a late offline preview is rejected after the cloud version changes', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    await setProvider(fixture.a, 'work', fixture.providerMarker);
    await fixture.a.reconcile();
    const preview = await fixture.b.state.sync!.preview({ kind: 'join', providerId: 'work' });

    await setProvider(fixture.a, 'work', `${fixture.providerMarker}-updated`);
    await fixture.a.reconcile();
    await expect(
      fixture.b.state.sync!.apply({
        previewId: preview.previewId,
        decisions: preview.rows.map((row) => ({ objectId: row.objectId, choice: 'cloud' as const })),
      }),
    ).rejects.toMatchObject({ code: 'preview-stale' });
  });
}, 30_000);

test('a public delete creates a tombstone that the restore operation can reactivate', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    await setProvider(fixture.a, 'work', fixture.providerMarker);
    await fixture.a.reconcile();
    await fixture.a.state.configStore.mutateConfig((current) => {
      const providers = { ...(current['providers'] as Record<string, unknown>) };
      delete providers['work'];
      return { ...current, providers };
    });
    await fixture.a.reconcile();

    const history = await fixture.a.state.sync!.history('provider-work');
    expect(history).toHaveLength(1);
    const restore = await fixture.a.state.sync!.preview({
      kind: 'restore',
      objectId: 'provider-work',
      operationId: history[0]!.operationId,
    });
    await fixture.a.state.sync!.apply({
      previewId: restore.previewId,
      decisions: restore.rows.map((row) => ({ objectId: row.objectId, choice: 'cloud' as const })),
    });
    await fixture.a.reconcile();
    expect(fixture.a.state.currentConfig().providers.some((provider) => provider.id === 'work')).toBe(true);
  });
}, 30_000);

test('same-ID collisions exclude both cloud objects before activation', async () => {
  await withTwoServerSyncFixtures(
    async (fixture) => {
      await setProvider(fixture.a, 'work', `${fixture.providerMarker}-a`);
      await setProvider(fixture.b, 'work', `${fixture.providerMarker}-b`);
      await fixture.a.reconcile();
      await fixture.b.reconcile();
      await fixture.a.reconcile();
      await fixture.b.reconcile();
      const rows = fixture.b.state.sync!.status().providers.filter((provider) => provider.providerId === 'work');
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ credentialState: 'independent', pendingReason: 'provider-id-conflict' }),
        ]),
      );
      expect(fixture.b.state.currentConfig().providers.some((provider) => provider.id === 'work')).toBe(false);
    },
    { providerObjectIds: { a: 'provider-work-a', b: 'provider-work-b' } },
  );
}, 30_000);

test('structured local model references survive a discovered provider', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    await setProvider(fixture.a, 'work', fixture.providerMarker);
    await fixture.a.state.configStore.mutateConfig((current) => ({
      ...current,
      router: {
        ...((current['router'] as Record<string, unknown> | undefined) ?? {}),
        models: {
          ...(((current['router'] as Record<string, unknown> | undefined)?.['models'] as Record<string, unknown>) ??
            {}),
          'shared-model': { providers: { work: { priority: 5, weight: 2 } } },
        },
      },
    }));
    await fixture.a.reconcile();
    await fixture.b.reconcile();
    const preview = await fixture.b.state.sync!.preview({ kind: 'join', providerId: 'shared-model' });
    expect(preview.rows).toContainEqual(
      expect.objectContaining({
        logicalKey: 'shared-model',
        local: { providers: { work: { priority: 5, weight: 2 } } },
        cloud: { providers: { work: { priority: 5, weight: 2 } } },
      }),
    );
  });
}, 30_000);

test('expired history is removed during the next public reconciliation', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    await setProvider(fixture.a, 'work', fixture.providerMarker);
    await fixture.a.reconcile();
    await setProvider(fixture.a, 'work', `${fixture.providerMarker}-updated`);
    await fixture.a.reconcile();
    fixture.backend.advance(31 * 24 * 60 * 60 * 1000);
    await fixture.a.reconcile();
    const history = await fixture.a.state.sync!.history('provider-work');
    expect(history).toEqual([expect.objectContaining({ current: true })]);
  });
}, 30_000);

test('unknown remote format remains read-only and marks the local identity upgrade-required', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    fixture.backend.inject('s/v1/default/entity/provider-work', new TextEncoder().encode('{"protocol":2}'));
    await fixture.b.reconcile();
    expect(fixture.b.state.sync!.status().providers).toContainEqual(
      expect.objectContaining({ providerId: 'work', pendingReason: 'upgrade-required' }),
    );
    expect(fixture.b.state.currentConfig().providers).toEqual([]);
  });
}, 30_000);

test('an identity switch fails the next public synchronization attempt', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    fixture.backend.setIdentity('acceptance-new-identity');
    await expect(fixture.a.state.sync!.retry()).rejects.toThrow('identity changed');
  });
}, 30_000);

test('invalid plugin updates fail without changing the configured public options', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    const before = await fixture.a.state.pluginControlPlane.editView(twoServerSyncAcceptancePlugin);
    await expect(
      fixture.a.state.pluginControlPlane.updateOptions({
        packageName: twoServerSyncAcceptancePlugin,
        revision: before.revision,
        publicValues: { endpoint: 'not-a-url' },
        secretValues: {},
        clearSecretKeys: [],
      }),
    ).rejects.toThrow();
    expect((await fixture.a.state.pluginControlPlane.editView(twoServerSyncAcceptancePlugin)).publicValues).toEqual(
      before.publicValues,
    );
  });
}, 30_000);

test('a shared backend outage leaves local configuration intact until refresh recovers', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    await setProvider(fixture.a, 'work', fixture.providerMarker);
    await fixture.a.reconcile();
    fixture.backend.setOnline(false);
    await fixture.a.state.sync!.retry();
    expect(fixture.a.state.currentConfig().providers.some((provider) => provider.id === 'work')).toBe(true);
    fixture.backend.setOnline(true);
    await fixture.a.reconcile();
    expect(fixture.a.state.sync!.status().state).toBe('idle');
  });
}, 30_000);
