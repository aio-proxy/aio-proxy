import { m } from '@aio-proxy/i18n';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import type { SectionSummary } from '../../../lib/section-status';
import { SectionShell } from '../section-shell';
import { WeightSliderField } from '../weight-slider-field';

interface RoutingSectionProps {
  readonly form: ProviderEditorForm;
  readonly summary: SectionSummary;
}

export const RoutingSection: React.FC<RoutingSectionProps> = ({ form, summary }) => (
  <SectionShell
    id="routing"
    title={m['dashboard.providers.editor.section_routing']()}
    description={m['dashboard.providers.editor.section_routing_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    <form.Field name="weight">
      {(field) => <WeightSliderField value={field.state.value} onChange={(weight) => field.handleChange(weight)} />}
    </form.Field>
  </SectionShell>
);
