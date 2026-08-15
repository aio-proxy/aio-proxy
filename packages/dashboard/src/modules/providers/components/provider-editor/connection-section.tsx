import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthCapability, DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';

import type { OAuthProviderForm } from '../../hooks/use-oauth-provider-form';
import type { ProviderEditorForm } from '../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../lib/constants';
import { capabilityKey } from '../../lib/oauth-capability-key';
import type { SectionSummary } from '../../lib/section-status';
import { OAuthAccountFields } from '../oauth-account-fields';
import { OAuthCapabilityCombobox } from '../oauth-capability-combobox';
import { OAuthProviderEditFields } from '../oauth-provider-edit-fields';
import { ProviderFormFieldsAiSdk } from '../provider-form-fields-ai-sdk';
import { ProviderFormFieldsApi } from '../provider-form-fields-api';
import { SectionShell } from './section-shell';

interface ConnectionSectionProps {
  readonly form: ProviderEditorForm;
  readonly accountForm?: OAuthProviderForm | undefined;
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;
  readonly capabilities?: readonly DashboardOAuthCapability[] | undefined;
  readonly oauth?: DashboardOAuthProviderEdit | undefined;
  readonly provider?: OAuthProvider | undefined;
  readonly onReauthorize?: (() => void) | undefined;
  readonly isReauthorizing?: boolean | undefined;
  readonly onOptionsValidityChange?: ((valid: boolean) => void) | undefined;
  readonly summary: SectionSummary;
}

export const ConnectionSection: React.FC<ConnectionSectionProps> = ({
  form,
  accountForm,
  mode,
  kind,
  capabilities,
  oauth,
  provider,
  onReauthorize,
  isReauthorizing,
  onOptionsValidityChange,
  summary,
}) => (
  <SectionShell
    id="connection"
    title={m['dashboard.providers.editor.section_connection']()}
    description={m['dashboard.providers.editor.section_connection_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    {kind === ProviderKind.Api ? <ProviderFormFieldsApi form={form} mode={mode} /> : null}
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
                onValueChange={(value) => {
                  field.handleChange(value === null ? '' : capabilityKey(value));
                  accountForm.setFieldValue('publicValues', value?.defaults ?? {});
                  accountForm.setFieldValue('secrets', {});
                  accountForm.setFieldValue('clearSecrets', []);
                  accountForm.setFieldValue('jsonValues', {});
                }}
              />
              {selected === undefined ? null : <OAuthAccountFields fields={selected.form} form={accountForm} />}
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
        isReauthorizing={isReauthorizing ?? false}
      />
    ) : null}
  </SectionShell>
);
