import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';

import type { ProviderEditorForm } from '../../hooks/use-provider-editor-form';
import type { SectionStatus } from '../../lib/section-status';
import { ProviderHeadersField } from '../provider-headers-field';
import { ProviderProxyField } from '../provider-proxy-field';
import { ProviderRequestTransformsFormField } from '../provider-request-transforms/provider-request-transforms-form-field';
import { SectionShell } from './section-shell';

interface AdvancedSectionProps {
  readonly form: ProviderEditorForm;
  readonly kind: ProviderKind;
  readonly status: SectionStatus;
  readonly onTransformsValidityChange: (valid: boolean) => void;
}

export const AdvancedSection: React.FC<AdvancedSectionProps> = ({ form, kind, status, onTransformsValidityChange }) => (
  <SectionShell id="advanced" title={m['dashboard.providers.editor.section_advanced']()} status={status}>
    <form.Field name="proxy">{(field) => <ProviderProxyField field={field} />}</form.Field>
    {kind === ProviderKind.Api ? (
      <form.Field name="headers">
        {(field) => (
          <ProviderHeadersField
            value={field.state.value as Readonly<Record<string, string>> | undefined}
            onChange={(headers) => field.handleChange(headers)}
          />
        )}
      </form.Field>
    ) : null}
    <ProviderRequestTransformsFormField form={form} onValidityChange={onTransformsValidityChange} />
  </SectionShell>
);
