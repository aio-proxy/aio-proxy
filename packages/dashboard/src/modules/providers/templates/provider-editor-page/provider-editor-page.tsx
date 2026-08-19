import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { Card, CardContent } from '@aio-proxy/ui/components/card';

import { PageContainer } from '@/components/page-container';

import { OAuthAuthorizationPanel } from '../../components/oauth-authorization-panel';
import { AdvancedSection } from '../../components/provider-editor/advanced-section';
import { ConnectionSection } from '../../components/provider-editor/connection-section';
import { ExposurePanel } from '../../components/provider-editor/exposure-panel';
import { IdentitySection } from '../../components/provider-editor/identity-section';
import { KindCard } from '../../components/provider-editor/kind-card';
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
    summaries,
    authorized,
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
  const locked = mode === ProviderFormMode.Create && kind === ProviderKind.OAuth && !authorized;
  const models = values.models ?? [];
  const exposed = exposedModels(models, oauth?.models);

  const sections345 = (
    <>
      <ModelsSection
        form={form}
        kind={kind}
        mode={mode}
        persistedProviderId={persistedId}
        candidates={oauth?.models}
        summary={summaries.models}
      />
      <RoutingSection
        form={form}
        models={models}
        candidates={oauth?.models}
        others={others}
        summary={summaries.routing}
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
      subtitle={subtitle}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.providers.list_title'](), to: '/providers' },
        { label: title },
      ]}
    >
      <SectionNav summaries={summaries} activeId={activeId} />
      {/* One form, so the editor is a form to the platform: labels, autofill and Enter all key off
          it. Submission is suppressed because saving is the footer primary's job — it is outside
          the fields, has to survive a `pending` state, and must not fire on an Enter keypress in a
          field the user is still editing. */}
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-4">
            {/* Above Identity and outside the nav: the kind is what decides which fields the sections
                below even contain, so it is not one of the provider's attributes (D-F11). */}
            <KindCard value={kind} mode={mode} onChange={handleKindChange} />
            <IdentitySection form={form} mode={mode} kind={kind} summary={summaries.identity} />
            <ConnectionSection
              form={form}
              accountForm={kind === ProviderKind.OAuth ? accountForm : undefined}
              mode={mode}
              kind={kind}
              capabilities={capabilities}
              oauth={oauth}
              provider={provider}
              onReauthorize={() => save(true)}
              isAuthorizationPending={isReauthorizing}
              onAuthorize={() => save(false)}
              onOptionsValidityChange={setOptionsValid}
              summary={summaries.connection}
            />
            {locked ? (
              <>
                <p className="rounded-lg border bg-muted p-3 text-sm">
                  {m['dashboard.providers.editor.authorization_locked_hint']()}
                </p>
                <fieldset disabled className="pointer-events-none space-y-4 opacity-60">
                  {sections345}
                </fieldset>
              </>
            ) : (
              sections345
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
                  alias={values.alias}
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
          </aside>
        </div>
        {/* Before the footer, not after it: this panel is inline markup, not a portal, and the footer is
            `sticky bottom-0`. Rendered after it, the device code and the manual-callback field sat in the
            band the footer is pinned over, and scrolling to the true bottom un-pinned the footer into the
            middle of the page, above the panel. Everything below this point must portal. */}
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
        <EditorFooter
          summaries={summaries}
          primaryLabel={primaryLabel}
          onPrimary={() => save(false)}
          onCancel={() => void navigate({ to: '/providers' })}
          pending={pending}
        />
      </form>
    </PageContainer>
  );
};
