import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { routingDraftNormalization } from '../../../lib/routing-draft-normalization';
import type { SectionSummary } from '../../../lib/section-status';
import { SectionShell } from '../section-shell';

interface RoutingSectionProps {
  readonly form: ProviderEditorForm;
  readonly summary: SectionSummary;
}

const numberChange = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  const next = Number(trimmed);
  return trimmed === '' || Number.isNaN(next) ? undefined : next;
};

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
    <div className="grid gap-4 sm:grid-cols-2">
      <form.Field name="priority">
        {(field) => (
          <Field data-testid="provider-form-field-priority">
            <FieldLabel htmlFor="provider-priority-input">{m['dashboard.providers.form.label_priority']()}</FieldLabel>
            <Input
              id="provider-priority-input"
              data-testid="priority-number-input"
              type="number"
              step="1"
              value={field.state.value ?? ''}
              onChange={(event) => field.handleChange(numberChange(event.target.value))}
            />
            <FieldDescription>{m['dashboard.providers.form.description_priority']()}</FieldDescription>
            {routingDraftNotice('priority', field.state.value)}
          </Field>
        )}
      </form.Field>
      <form.Field name="weight">
        {(field) => (
          <Field data-testid="provider-form-field-weight">
            <FieldLabel htmlFor="provider-weight-input">{m['dashboard.providers.form.label_weight']()}</FieldLabel>
            <Input
              id="provider-weight-input"
              data-testid="weight-number-input"
              type="number"
              step="any"
              value={field.state.value ?? ''}
              onChange={(event) => field.handleChange(numberChange(event.target.value))}
            />
            <FieldDescription>{m['dashboard.providers.editor.weight_description']()}</FieldDescription>
            {routingDraftNotice('weight', field.state.value)}
          </Field>
        )}
      </form.Field>
    </div>
  </SectionShell>
);
