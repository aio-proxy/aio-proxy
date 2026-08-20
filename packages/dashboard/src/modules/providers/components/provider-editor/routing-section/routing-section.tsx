import { m } from '@aio-proxy/i18n';
import { type DashboardProviderSummary, modelRoutes } from '@aio-proxy/types';
import { Field } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { toAliasRecord } from '../../../lib/alias-editor';
import type { SectionSummary } from '../../../lib/section-status';
import { AttemptOrderPreview } from '../attempt-order-preview';
import { SectionShell } from '../section-shell';
import { WeightSliderField } from '../weight-slider-field';

interface RoutingSectionProps {
  readonly form: ProviderEditorForm;
  /** The raw whitelist. Empty means "no whitelist", i.e. the discovered catalog is what gets exposed. */
  readonly models: readonly string[];
  /** The discovered catalog; what an empty whitelist exposes. */
  readonly candidates?: readonly string[] | undefined;
  readonly others: readonly Pick<DashboardProviderSummary, 'id' | 'weight' | 'clientModels' | 'enabled'>[];
  readonly summary: SectionSummary;
}

export const RoutingSection: React.FC<RoutingSectionProps> = ({ form, models, candidates, others, summary }) => {
  const exposed = models.length === 0 ? (candidates ?? []) : models;
  return (
    <SectionShell
      id="routing"
      title={m['dashboard.providers.editor.section_routing']()}
      description={m['dashboard.providers.editor.section_routing_description']()}
      status={summary.status}
      statusHint={summary.hint}
    >
      <div data-testid="provider-editor-field-enabled">
        <form.Field name="enabled">
          {(field) => (
            <Field orientation="horizontal">
              <Switch
                id="provider-routing-enabled"
                checked={field.state.value ?? true}
                onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
              />
              <Label htmlFor="provider-routing-enabled">{m['dashboard.providers.form.label_enabled']()}</Label>
            </Field>
          )}
        </form.Field>
      </div>

      <form.Subscribe selector={(state) => state.values.enabled}>
        {(enabled) => (
          <form.Field name="weight">
            {(field) => (
              // `undefined` is the switch's own enabled default, so only an explicit `false` is off.
              <WeightSliderField
                value={field.state.value}
                disabled={enabled === false}
                onChange={(weight) => field.handleChange(weight)}
              />
            )}
          </form.Field>
        )}
      </form.Subscribe>

      <form.Subscribe
        selector={(state) => [state.values.id, state.values.weight, state.values.alias, state.values.enabled] as const}
      >
        {([id, weight, alias, enabled]) => (
          <AttemptOrderPreview
            selfId={id ?? ''}
            selfWeight={weight}
            // The live switch value, which only dims and relabels the self row.
            selfEnabled={enabled}
            // A disabled self is still previewed, so the routes are derived unconditionally.
            exposedAliases={modelRoutes({
              enabled: true,
              models: exposed,
              alias: alias === undefined ? undefined : toAliasRecord(alias),
            }).map((route) => route.alias)}
            others={others}
          />
        )}
      </form.Subscribe>
    </SectionShell>
  );
};
