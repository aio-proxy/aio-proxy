import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import type { SyncPreview, SyncPreviewInput } from '@aio-proxy/types';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import { useState } from 'react';

import { PageContainer } from '@/components/page-container';
import { SyncRequestError, useDetachSync, usePreviewSync, useSetSyncRange, useSyncStatus } from '@/lib/sync';

import { SyncPreviewDialog } from '../../../settings/components/sync-preview-dialog';
import { AdvancedSection } from '../../components/provider-editor/advanced-section';
import { ConnectionSection } from '../../components/provider-editor/connection-section';
import { ExposurePanel } from '../../components/provider-editor/exposure-panel';
import { IdentitySection } from '../../components/provider-editor/identity-section';
import { KindCard } from '../../components/provider-editor/kind-card';
import { ModelValidationPanel } from '../../components/provider-editor/model-validation-panel';
import { ModelsSection } from '../../components/provider-editor/models-section';
import { ProviderSyncControl } from '../../components/provider-sync-control';
import { useActiveSection } from '../../hooks/use-active-section';
import { editorEffectiveAlias, toAliasRecord } from '../../lib/alias-editor';
import { ProviderFormMode } from '../../lib/constants';
import { exposedModels, oauthEditorExposedModels } from '../../lib/exposed-models';
import { EditorFooter } from './editor-footer';
import { SectionNav } from './section-nav';
import { type ProviderEditorPageProps, useProviderEditorPage } from './use-provider-editor-page';

export type { ProviderEditorPageProps };

type ProviderSyncPreviewInput = Extract<SyncPreviewInput, { kind: 'join' | 'overrides' }>;

export const ProviderEditorPage: React.FC<ProviderEditorPageProps> = (props) => {
  const {
    form,
    accountForm,
    kind,
    mode,
    capabilities,
    oauth,
    provider,
    summaries,
    authorized,
    hasApiKey,
    sessionWarning,
    values,
    persistedId,
    session,
    sessionQuery,
    callbackMutation,
    cancelMutation,
    onSessionIdChange,
    handleKindChange,
    setOptionsValid,
    setTransformsValid,
    save,
    saveBlocked,
    isReauthorizing,
    pending,
    primaryLabel,
    title,
    navigate,
  } = useProviderEditorPage(props);
  const activeId = useActiveSection(kind);
  const syncStatus = useSyncStatus();
  const previewMutation = usePreviewSync();
  const rangeMutation = useSetSyncRange();
  const detachMutation = useDetachSync();
  const [syncPreview, setSyncPreview] = useState<SyncPreview | null>(null);
  const [lastSyncPreviewInput, setLastSyncPreviewInput] = useState<ProviderSyncPreviewInput>();
  const locked = mode === ProviderFormMode.Create && kind === ProviderKind.OAuth && !authorized;
  const models = values.kind === 'oauth' ? [] : (values.models ?? []);
  const exposed =
    kind === ProviderKind.OAuth
      ? oauthEditorExposedModels(oauth?.models, values.kind === 'oauth' ? values.excludedModels : undefined)
      : exposedModels(models, oauth?.models);
  const railAlias =
    kind === ProviderKind.OAuth
      ? editorEffectiveAlias(
          values.alias ?? [],
          oauth?.pluginAliases,
          exposed,
          values.kind === 'oauth' && values.pluginAliasInherit === false,
        )
      : values.alias === undefined
        ? undefined
        : toAliasRecord(values.alias);
  const providerSync =
    persistedId === undefined
      ? undefined
      : syncStatus.data?.providers.find((entry) => entry.providerId === persistedId);
  const previewInput = async (input: ProviderSyncPreviewInput) => {
    setLastSyncPreviewInput(input);
    setSyncPreview(await previewMutation.mutateAsync(input));
  };
  const openSyncPreview = async () => {
    if (persistedId === undefined) return;
    await previewInput({ kind: 'join', providerId: persistedId });
  };
  const previewOverrides = async (paths: readonly string[][]) => {
    const objectId = syncPreview?.rows[0]?.objectId;
    if (objectId === undefined) throw new Error('SYNC_PREVIEW_OBJECT_MISSING');
    await previewInput({ kind: 'overrides', objectId, paths: paths.map((path) => [...path]) });
  };

  const identitySection = <IdentitySection form={form} mode={mode} kind={kind} summary={summaries.identity} />;
  const connectionSection = (
    <ConnectionSection
      form={form}
      accountForm={kind === ProviderKind.OAuth ? accountForm : undefined}
      mode={mode}
      kind={kind}
      hasApiKey={hasApiKey}
      capabilities={capabilities}
      oauth={oauth}
      provider={provider}
      accountLocked={
        kind === ProviderKind.OAuth &&
        (isReauthorizing ||
          (mode === ProviderFormMode.Create && authorized) ||
          (session !== undefined &&
            session.status !== 'failed' &&
            session.status !== 'cancelled' &&
            session.status !== 'succeeded'))
      }
      onReauthorize={() => save(true)}
      isReauthorizeBlocked={saveBlocked}
      isAuthorizationPending={isReauthorizing}
      onAuthorize={() => save(false)}
      onOptionsValidityChange={setOptionsValid}
      summary={summaries.connection}
      session={
        props.sessionId !== undefined && session !== undefined && session.status !== 'succeeded' ? session : undefined
      }
      isSessionPending={callbackMutation.isPending || cancelMutation.isPending}
      onSubmitCallback={(callbackUrl) =>
        session === undefined
          ? undefined
          : callbackMutation.mutate({ id: session.id, callbackUrl }, { onSuccess: () => sessionQuery.refetch() })
      }
      onClearSession={() => {
        if (session === undefined) return;
        if (session.status === 'failed' || session.status === 'cancelled') {
          onSessionIdChange(undefined);
          return;
        }
        cancelMutation.mutate(session.id);
      }}
      onCancelSession={() => {
        if (session === undefined) return;
        if (session.status === 'failed' || session.status === 'cancelled') {
          onSessionIdChange(undefined);
          save(false);
          return;
        }
        cancelMutation.mutate(session.id);
      }}
    />
  );
  const sections12 =
    kind === ProviderKind.OAuth ? (
      <>
        {connectionSection}
        {identitySection}
      </>
    ) : (
      <>
        {identitySection}
        {connectionSection}
      </>
    );
  const sections34 = (
    <>
      <ModelsSection
        form={form}
        kind={kind}
        persistedProviderId={persistedId}
        candidates={oauth?.models}
        pluginAliases={oauth?.pluginAliases}
        summary={summaries.models}
      />
      <AdvancedSection
        form={form}
        kind={kind}
        summary={summaries.advanced}
        onTransformsValidityChange={setTransformsValid}
      />
    </>
  );

  return (
    <PageContainer
      title={title}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.providers.list_title'](), to: '/providers' },
        { label: title },
      ]}
    >
      <SectionNav summaries={summaries} activeId={activeId} kind={kind} />
      {/* One form, so the editor is a form to the platform: labels, autofill and Enter all key off
          it. Submission is suppressed because saving is the footer primary's job — it is outside
          the fields, has to survive a `pending` state, and must not fire on an Enter keypress in a
          field the user is still editing. */}
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="grid gap-4 pb-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-4">
            {/* Above Identity and outside the nav: the kind is what decides which fields the sections
                below even contain, so it is not one of the provider's attributes (D-F11). */}
            <KindCard value={kind} mode={mode} onChange={handleKindChange} />
            {sections12}
            {locked ? (
              <>
                <p className="rounded-lg border bg-muted p-3 text-sm">
                  {m['dashboard.providers.editor.authorization_locked_hint']()}
                </p>
                <fieldset disabled className="pointer-events-none space-y-4 opacity-60">
                  {sections34}
                </fieldset>
              </>
            ) : (
              sections34
            )}
          </div>
          {/* Stacks under the form below `lg`; above it, stays in view while the user works down the
              sections. `top-18` clears the sticky nav strip by the same offset a jumped-to section keeps
              (`SectionShell`'s `scroll-mt-18`), so the panel lines up with the section it describes. */}
          <aside className="space-y-4 lg:sticky lg:top-18 lg:self-start">
            {/* Each panel brings its own heading, so `CardContent` alone — a `CardHeader` here would
                double it. */}
            <Card size="sm">
              <CardContent>
                <ExposurePanel
                  models={exposed}
                  alias={railAlias}
                  enabled={values.enabled ?? true}
                  warning={sessionWarning}
                />
              </CardContent>
            </Card>
            <Card size="sm">
              <CardContent>
                <ModelValidationPanel
                  form={form}
                  kind={kind}
                  persistedProviderId={persistedId}
                  testableModels={exposed}
                />
              </CardContent>
            </Card>
            {providerSync === undefined ? null : (
              <ProviderSyncControl
                state={providerSync}
                onEnable={openSyncPreview}
                onExclude={() =>
                  rangeMutation
                    .mutateAsync({ providerId: providerSync.providerId, included: false })
                    .then(() => undefined)
                }
                onDetach={() =>
                  session?.id === undefined
                    ? Promise.reject(new SyncRequestError('login-required', 401))
                    : detachMutation
                        .mutateAsync({ providerId: providerSync.providerId, loginSessionId: session.id })
                        .then(() => undefined)
                }
              />
            )}
          </aside>
        </div>
        <EditorFooter
          summaries={summaries}
          kind={kind}
          primaryLabel={primaryLabel}
          onPrimary={() => save(false)}
          onCancel={() => void navigate({ to: '/providers' })}
          pending={pending}
        />
      </form>
      <SyncPreviewDialog
        open={syncPreview !== null}
        preview={syncPreview}
        onOpenChange={(open) => {
          if (!open) setSyncPreview(null);
        }}
        onApplied={() => setSyncPreview(null)}
        onRetry={async () => {
          if (lastSyncPreviewInput === undefined) return;
          await previewInput(lastSyncPreviewInput);
        }}
        onPreviewOverrides={previewOverrides}
      />
    </PageContainer>
  );
};
