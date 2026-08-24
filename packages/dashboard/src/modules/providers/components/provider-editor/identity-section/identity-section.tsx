import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';
import type { SectionSummary } from '../../../lib/section-status';
import { SectionShell } from '../section-shell';
import { IdentityFields } from './identity-fields';

interface IdentitySectionProps {
  readonly form: ProviderEditorForm;
  readonly mode: ProviderFormMode;
  /** Only to decide whether the server assigns the id; the kind is picked in `KindCard`, above. */
  readonly kind: ProviderKind;
  readonly summary: SectionSummary;
}

export const IdentitySection: React.FC<IdentitySectionProps> = ({ form, mode, kind, summary }) => (
  <SectionShell
    id="identity"
    title={m['dashboard.providers.editor.section_identity']()}
    description={m['dashboard.providers.editor.section_identity_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    <IdentityFields
      form={form}
      mode={mode}
      serverAssignsId={kind === ProviderKind.OAuth && mode === ProviderFormMode.Create}
    />
  </SectionShell>
);
