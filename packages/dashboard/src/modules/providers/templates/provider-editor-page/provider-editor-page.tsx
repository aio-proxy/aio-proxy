import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { useRef } from 'react';

import { PageContainer } from '@/components/page-container';

import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../../components/delete-provider-dialog';
import { OAuthAuthorizationPanel } from '../../components/oauth-authorization-panel';
import { AdvancedSection } from '../../components/provider-editor/advanced-section';
import { ConnectionSection } from '../../components/provider-editor/connection-section';
import { ExposurePanel } from '../../components/provider-editor/exposure-panel';
import { IdentitySection } from '../../components/provider-editor/identity-section';
import { ModelValidationPanel } from '../../components/provider-editor/model-validation-panel';
import { ModelsSection } from '../../components/provider-editor/models-section';
import { RoutingSection } from '../../components/provider-editor/routing-section';
import { useActiveSection } from '../../hooks/use-active-section';
import { ProviderFormMode } from '../../lib/constants';
import { exposedModels } from '../../lib/exposed-models';
import { EditorFooter } from './editor-footer';
import { SectionNav } from './section-nav';
import { type ProviderEditorPageProps, useProviderEditorPage } from './use-provider-editor-page';

export type { ProviderEditorPageProps };

export const ProviderEditorPage: React.FC<ProviderEditorPageProps> = (props) => {
  const {
    form,
    accountForm,
    kind,
    mode,
    capabilities,
    oauth,
    provider,
    statuses,
    blocking,
    authorized,
    saved,
    sessionWarning,
    values,
    others,
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
    isReauthorizing,
    pending,
    primaryLabel,
    title,
    subtitle,
    navigate,
  } = useProviderEditorPage(props);
  const activeId = useActiveSection();
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const locked = mode === ProviderFormMode.Create && kind === ProviderKind.OAuth && !authorized;
  const models = values.models ?? [];
  const exposed = exposedModels(models, oauth?.models);

  const sections345 = (
    <>
      <ModelsSection
        form={form}
        kind={kind}
        persistedProviderId={persistedId}
        candidates={oauth?.models}
        status={statuses.models}
      />
      <RoutingSection
        form={form}
        mode={mode}
        models={models}
        candidates={oauth?.models}
        others={others}
        status={statuses.routing}
      />
      <AdvancedSection
        form={form}
        kind={kind}
        status={statuses.advanced}
        onTransformsValidityChange={setTransformsValid}
      />
    </>
  );

  return (
    <PageContainer
      title={title}
      {...(subtitle === undefined ? {} : { subtitle })}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.providers.list_title'](), to: '/providers' },
        { label: title },
      ]}
    >
      <div className="flex gap-8">
        <SectionNav statuses={statuses} activeId={activeId} />
        <div className="max-w-6xl min-w-0 flex-1 space-y-10">
          <IdentitySection
            form={form}
            mode={mode}
            kind={kind}
            onKindChange={handleKindChange}
            status={statuses.identity}
          />
          <ConnectionSection
            form={form}
            accountForm={kind === ProviderKind.OAuth ? accountForm : undefined}
            mode={mode}
            kind={kind}
            capabilities={capabilities}
            oauth={oauth}
            provider={provider}
            onReauthorize={() => save(true)}
            isReauthorizing={isReauthorizing}
            onOptionsValidityChange={setOptionsValid}
            status={statuses.connection}
          />
          {locked ? (
            <>
              <p className="rounded-lg border bg-muted p-3 text-sm">
                {m['dashboard.providers.editor.authorization_locked_hint']()}
              </p>
              <fieldset disabled className="pointer-events-none space-y-10 opacity-60">
                {sections345}
              </fieldset>
            </>
          ) : (
            sections345
          )}
        </div>
        <aside className="w-72 shrink-0 space-y-8">
          <ExposurePanel
            models={exposed}
            alias={values.alias}
            enabled={values.enabled ?? true}
            warning={sessionWarning}
          />
          <ModelValidationPanel form={form} kind={kind} persistedProviderId={persistedId} testableModels={exposed} />
        </aside>
      </div>
      {saved ? (
        <p className="mt-4 text-sm text-muted-foreground">{m['dashboard.providers.editor.footer_saved']()}</p>
      ) : null}
      <EditorFooter
        blocking={blocking}
        primaryLabel={primaryLabel}
        onPrimary={() => save(false)}
        onCancel={() => void navigate({ to: '/providers' })}
        onDelete={
          mode === ProviderFormMode.Edit && props.providerId !== undefined
            ? () => deleteDialogRef.current?.open({ id: props.providerId as string })
            : undefined
        }
        pending={pending}
      />
      {props.sessionId !== undefined && session !== undefined && session.status !== 'succeeded' ? (
        <OAuthAuthorizationPanel
          session={session}
          isPending={callbackMutation.isPending || cancelMutation.isPending}
          onSubmitCallback={(callbackUrl) =>
            callbackMutation.mutate({ id: session.id, callbackUrl }, { onSuccess: () => sessionQuery.refetch() })
          }
          onCancel={() => {
            if (session.status === 'failed' || session.status === 'cancelled') {
              onSessionIdChange(undefined);
              return;
            }
            cancelMutation.mutate(session.id);
          }}
        />
      ) : null}
      <DeleteProviderDialog ref={deleteDialogRef} onDeleted={() => void navigate({ to: '/providers' })} />
    </PageContainer>
  );
};
