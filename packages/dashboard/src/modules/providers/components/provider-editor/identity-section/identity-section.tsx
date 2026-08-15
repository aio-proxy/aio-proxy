import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import type { SectionSummary } from '../../../lib/section-status';
import { ProviderCommonFields } from '../../provider-common-fields';
import { SectionShell } from '../section-shell';
import { KindPicker } from './kind-picker';

interface IdentitySectionProps {
  readonly form: ProviderEditorForm;
  readonly mode: ProviderFormMode;
  readonly kind: ProviderKind;
  readonly onKindChange?: ((kind: ProviderKind) => void) | undefined;
  readonly summary: SectionSummary;
}

export const IdentitySection: React.FC<IdentitySectionProps> = ({ form, mode, kind, onKindChange, summary }) => (
  <SectionShell
    id="identity"
    title={m['dashboard.providers.editor.section_identity']()}
    description={m['dashboard.providers.editor.section_identity_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    <KindPicker value={kind} onChange={(next) => onKindChange?.(next)} locked={mode === ProviderFormMode.Edit} />
    <ProviderCommonFields
      form={form}
      mode={mode}
      serverAssignsId={kind === ProviderKind.OAuth && mode === ProviderFormMode.Create}
    />
  </SectionShell>
);
