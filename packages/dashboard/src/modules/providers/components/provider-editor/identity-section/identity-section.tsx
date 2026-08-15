import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { Field } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import type { SectionSummary } from '../../../lib/section-status';
import { ProviderCommonFields } from '../../provider-common-fields';
import { SectionShell } from '../section-shell';

interface IdentitySectionProps {
  readonly form: ProviderEditorForm;
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;
  readonly onKindChange?: ((kind: ProviderKind) => void) | undefined;
  readonly summary: SectionSummary;
}

const KIND_LABEL_KEYS = {
  [ProviderKind.Api]: 'dashboard.providers.editor.kind_api',
  [ProviderKind.AiSdk]: 'dashboard.providers.editor.kind_ai_sdk',
  [ProviderKind.OAuth]: 'dashboard.providers.editor.kind_oauth',
} as const;

export const IdentitySection: React.FC<IdentitySectionProps> = ({ form, mode, kind, onKindChange, summary }) => (
  <SectionShell
    id="identity"
    title={m['dashboard.providers.editor.section_identity']()}
    description={m['dashboard.providers.editor.section_identity_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    {mode === ProviderFormMode.Create ? (
      <div data-testid="provider-editor-field-kind">
        <Field>
          <Label>{m['dashboard.providers.editor.kind_label']()}</Label>
          <Select value={kind} onValueChange={(value) => onKindChange?.(value as ProviderKind)}>
            <SelectTrigger className="w-full">
              {/* Base UI renders the raw value without an `items` map, so map it to the localized label. */}
              <SelectValue>{(value: ProviderKind) => m[KIND_LABEL_KEYS[value]]()}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.values(ProviderKind).map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {m[KIND_LABEL_KEYS[candidate]]()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    ) : null}
    {/* oauth create: no id field, the server assigns session.providerId */}
    <ProviderCommonFields
      form={form}
      mode={kind === ProviderKind.OAuth && mode === ProviderFormMode.Create ? ProviderFormMode.Edit : mode}
      section="connection"
    />
  </SectionShell>
);
