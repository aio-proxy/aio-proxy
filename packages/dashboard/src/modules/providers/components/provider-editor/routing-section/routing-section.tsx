import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { routingDraftNormalization } from '../../../lib/routing-draft-normalization';
import type { SectionSummary } from '../../../lib/section-status';
import { SectionShell } from '../section-shell';
import { WeightSliderField } from '../weight-slider-field';

interface RoutingSectionProps {
  readonly form: ProviderEditorForm;
  readonly summary: SectionSummary;
}

const routingDraftNotice = (kind: 'priority' | 'weight', authored: number | undefined) => {
  const notice = routingDraftNormalization(kind, authored);
  return notice === undefined ? null : (
    <FieldDescription>
      {m['dashboard.providers.form.normalize_notice']({
        authored: notice.authored,
        effective: notice.effective,
      })}
    </FieldDescription>
  );
};

export const RoutingSection: React.FC<RoutingSectionProps> = ({ form, summary }) => (
  <SectionShell
    id="routing"
    title={m['dashboard.providers.editor.section_routing']()}
    description={m['dashboard.providers.editor.section_routing_description']()}
    status={summary.status}
    statusHint={summary.hint}
  >
    <div className="grid gap-6">
      <form.Field name="priority">
        {(field) => (
          <Field data-testid="provider-form-field-priority">
            <FieldLabel htmlFor="provider-priority-input">{m['dashboard.providers.form.label_priority']()}</FieldLabel>
            <Input
              id="provider-priority-input"
              type="number"
              step="1"
              value={field.state.value ?? ''}
              onChange={(event) =>
                field.handleChange(event.target.value === '' ? undefined : Number(event.target.value))
              }
            />
            <FieldDescription>{m['dashboard.providers.form.description_priority']()}</FieldDescription>
            {routingDraftNotice('priority', field.state.value)}
          </Field>
        )}
      </form.Field>
      <form.Field name="weight">
        {(field) => (
          <>
            <WeightSliderField value={field.state.value} onChange={(weight) => field.handleChange(weight)} />
            {routingDraftNotice('weight', field.state.value)}
          </>
        )}
      </form.Field>
    </div>
  </SectionShell>
);
