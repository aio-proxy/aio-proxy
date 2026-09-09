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

test('selected Provider and plugin secrets synchronize; purge leaves an independent local copy', async () => {
  await withTwoServerSyncFixtures(async (fixture) => {
    const { a, b } = fixture;
    expect(a.state.sync).toBeDefined();
    expect(b.state.sync).toBeDefined();
    expect(
      a.state.pluginControlPlane.summaries().some((plugin) => plugin.packageName === twoServerSyncAcceptancePlugin),
    ).toBe(true);

    await a.state.configStore.mutateConfig((current) => ({
      ...current,
      providers: {
        ...(current['providers'] as Record<string, unknown>),
        work: {
          kind: 'api',
          protocol: 'openai-compatible',
          apiKey: a.providerMarker,
          baseURL: 'https://work.example.test/v1',
        },
      },
    }));
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
