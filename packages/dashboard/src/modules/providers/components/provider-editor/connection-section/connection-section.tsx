import { m } from '@aio-proxy/i18n';
import type {
  DashboardOAuthCapability,
  DashboardOAuthProviderEdit,
  DashboardOAuthSession,
  OAuthProvider,
} from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Spinner } from '@aio-proxy/ui/components/spinner';

import type { OAuthProviderForm } from '../../../hooks/use-oauth-provider-form';
import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import { capabilityKey } from '../../../lib/oauth-capability-key';
import type { SectionSummary } from '../../../lib/section-status';
import { OAuthAccountFields } from '../../oauth-account-fields';
import { OAuthAuthorizationPanel } from '../../oauth-authorization-panel';
import { OAuthCapabilityCombobox } from '../../oauth-capability-combobox';
import { OAuthProviderEditFields } from '../../oauth-provider-edit-fields';
import { ProviderFormFieldsAiSdk } from '../../provider-form-fields-ai-sdk';
import { ProviderFormFieldsApi } from '../../provider-form-fields-api';
import { SectionShell } from '../section-shell';

interface ConnectionSectionProps {
  readonly form: ProviderEditorForm;
  readonly accountForm?: OAuthProviderForm | undefined;
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;
  /** api only: whether a key is already stored, which decides the API Key field's copy. */
  readonly hasApiKey?: boolean | undefined;
  readonly capabilities?: readonly DashboardOAuthCapability[] | undefined;
  readonly oauth?: DashboardOAuthProviderEdit | undefined;
  readonly provider?: OAuthProvider | undefined;
  readonly onReauthorize?: (() => void) | undefined;
  /** True when `onReauthorize` would refuse: an outstanding section blocks the save it performs. */
  readonly isReauthorizeBlocked?: boolean | undefined;
  /** True while an authorization start is in flight: a first authorize in create, a reauthorize in edit. */
  readonly isAuthorizationPending?: boolean | undefined;
  /** OAuth create only: starts the authorization from inside this section. */
  readonly onAuthorize?: (() => void) | undefined;
  readonly onOptionsValidityChange?: ((valid: boolean) => void) | undefined;
  readonly summary: SectionSummary;
  readonly session?: DashboardOAuthSession | undefined;
  readonly isSessionPending?: boolean | undefined;
  readonly onSubmitCallback?: ((callbackUrl: string) => void) | undefined;
  readonly onCancelSession?: (() => void) | undefined;
  readonly onClearSession?: (() => void) | undefined;
  readonly accountLocked?: boolean | undefined;
}

export const ConnectionSection: React.FC<ConnectionSectionProps> = ({
  form,
  accountForm,
  mode,
  kind,
  hasApiKey,
  capabilities,
  oauth,
  provider,
  onReauthorize,
  isReauthorizeBlocked,
  isAuthorizationPending,
  onAuthorize,
  onOptionsValidityChange,
  summary,
  session,
  isSessionPending,
  onSubmitCallback,
  onCancelSession,
  onClearSession,
  accountLocked = false,
}) => (
  <SectionShell
    id="connection"
    title={m['dashboard.providers.editor.section_connection']()}
    description={m['dashboard.providers.editor.section_connection_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    {kind === ProviderKind.Api ? <ProviderFormFieldsApi form={form} hasApiKey={hasApiKey ?? false} /> : null}
    {kind === ProviderKind.AiSdk ? (
      <ProviderFormFieldsAiSdk form={form} onOptionsValidityChange={onOptionsValidityChange} />
    ) : null}
    {kind === ProviderKind.OAuth && mode === ProviderFormMode.Create && accountForm !== undefined ? (
      <accountForm.Field name="capabilityKey">
        {(field) => {
          const selected = (capabilities ?? []).find((candidate) => capabilityKey(candidate) === field.state.value);
          return (
            <>
              <OAuthCapabilityCombobox
                capabilities={capabilities ?? []}
                value={selected ?? null}
                disabled={accountLocked}
                onValueChange={(value) => {
                  field.handleChange(value === null ? '' : capabilityKey(value));
                  accountForm.setFieldValue('publicValues', value?.defaults ?? {});
                  accountForm.setFieldValue('secrets', {});
                  accountForm.setFieldValue('clearSecrets', []);
                  accountForm.setFieldValue('jsonValues', {});
                  onClearSession?.();
                }}
              />
              {selected === undefined ? null : (
                <OAuthAccountFields fields={selected.form} form={accountForm} locked={accountLocked} />
              )}
              {/* Below the account fields it submits: this button posts them, so it cannot sit above. */}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  data-testid="connection-authorize"
                  size="sm"
                  disabled={field.state.value === '' || isAuthorizationPending === true || accountLocked}
                  onClick={onAuthorize}
                >
                  {isAuthorizationPending === true ? <Spinner data-icon="inline-start" /> : null}
                  {m['dashboard.providers.oauth.authorize_in_browser']()}
                </Button>
                <p className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.authorize_popup_hint']()}</p>
              </div>
            </>
          );
        }}
      </accountForm.Field>
    ) : null}
    {kind === ProviderKind.OAuth &&
    mode === ProviderFormMode.Edit &&
    accountForm !== undefined &&
    oauth !== undefined &&
    provider !== undefined ? (
      <OAuthProviderEditFields
        provider={provider}
        oauth={oauth}
        accountForm={accountForm}
        onReauthorize={onReauthorize ?? (() => undefined)}
        isReauthorizing={isAuthorizationPending ?? false}
        isReauthorizeBlocked={isReauthorizeBlocked ?? false}
        accountLocked={accountLocked}
      />
    ) : null}
    {session !== undefined &&
    session.status !== 'succeeded' &&
    onSubmitCallback !== undefined &&
    onCancelSession !== undefined ? (
      <OAuthAuthorizationPanel
        session={session}
        isPending={isSessionPending ?? false}
        onSubmitCallback={onSubmitCallback}
        onCancel={onCancelSession}
      />
    ) : null}
  </SectionShell>
);
