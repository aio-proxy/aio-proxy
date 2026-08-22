import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import type React from 'react';

import type { useRoutingForm } from '../hooks/use-routing-form';
import { effectiveRoutingCandidates, routingDraftNormalization } from '../lib/routing-summary';

interface RoutingProviderFieldsProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly provider: DashboardRoutingProvider;
  readonly writable: boolean;
}

const numberChange = (value: string): number | undefined => (value === '' ? undefined : Number(value));

const normalizeNotice = (kind: 'priority' | 'weight', authored: number | undefined) => {
  const notice = routingDraftNormalization(kind, authored);
  return notice === undefined
    ? null
    : m['dashboard.routing.editor.normalize_notice']({ authored: notice.authored, effective: notice.effective });
};

export const RoutingProviderFields: React.FC<RoutingProviderFieldsProps> = ({ form, provider, writable }) => (
  <form.Field name={`providers.${provider.id}.priority`}>
    {(priorityField) => (
      <form.Field name={`providers.${provider.id}.weight`}>
        {(weightField) => {
          const draft = { priority: priorityField.state.value, weight: weightField.state.value };
          const [candidate] = effectiveRoutingCandidates([provider], { [provider.id]: draft });
          const hasOverride = draft.priority !== undefined || draft.weight !== undefined;
          const priorityNotice = normalizeNotice('priority', draft.priority);
          const weightNotice = normalizeNotice('weight', draft.weight);
          const stateLabel =
            provider.state.status === 'unavailable'
              ? m['dashboard.routing.editor.provider_unavailable']()
              : m['dashboard.routing.editor.provider_ready']();
          return (
            <div className="space-y-3 border-b py-4 last:border-b-0" data-testid={`routing-provider-${provider.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0">
                  {provider.name === undefined ? null : <div className="font-medium">{provider.name}</div>}
                  <div className="font-mono text-xs text-muted-foreground">{provider.id}</div>
                </div>
                <Badge variant="outline">{stateLabel}</Badge>
                {provider.enabled ? null : (
                  <Badge variant="secondary">{m['dashboard.routing.editor.provider_disabled']()}</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {m['dashboard.routing.editor.default_priority']({ value: provider.defaults.priority.effective })}
                {' · '}
                {m['dashboard.routing.editor.default_weight']({ value: provider.defaults.weight.effective })}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`routing-override-priority-${provider.id}`}>
                    {m['dashboard.routing.editor.override_priority']()}
                  </FieldLabel>
                  <Input
                    id={`routing-override-priority-${provider.id}`}
                    data-testid={`routing-override-priority-${provider.id}`}
                    type="number"
                    step="1"
                    disabled={!writable}
                    value={priorityField.state.value ?? ''}
                    placeholder={String(provider.defaults.priority.effective)}
                    onChange={(event) => priorityField.handleChange(numberChange(event.target.value))}
                  />
                  <FieldDescription>
                    {draft.priority === undefined
                      ? m['dashboard.routing.editor.inherited_hint']({ value: provider.defaults.priority.effective })
                      : m['dashboard.routing.editor.source_model']()}
                  </FieldDescription>
                  {priorityNotice === null ? null : <FieldDescription>{priorityNotice}</FieldDescription>}
                </Field>
                <Field>
                  <FieldLabel htmlFor={`routing-override-weight-${provider.id}`}>
                    {m['dashboard.routing.editor.override_weight']()}
                  </FieldLabel>
                  <Input
                    id={`routing-override-weight-${provider.id}`}
                    data-testid={`routing-override-weight-${provider.id}`}
                    type="number"
                    step="any"
                    disabled={!writable}
                    value={weightField.state.value ?? ''}
                    placeholder={String(provider.defaults.weight.effective)}
                    onChange={(event) => weightField.handleChange(numberChange(event.target.value))}
                  />
                  <FieldDescription>
                    {draft.weight === undefined
                      ? m['dashboard.routing.editor.inherited_hint']({ value: provider.defaults.weight.effective })
                      : m['dashboard.routing.editor.source_model']()}
                  </FieldDescription>
                  {weightNotice === null ? null : <FieldDescription>{weightNotice}</FieldDescription>}
                </Field>
              </div>
              <p className="text-sm">
                {m['dashboard.routing.editor.effective']({
                  value: `${candidate?.priority ?? provider.effective.priority} / ${candidate?.weight ?? provider.effective.weight}`,
                })}
              </p>
              {candidate?.weight === 0 ? (
                <Badge data-testid={`routing-disabled-${provider.id}`} variant="outline">
                  {m['dashboard.routing.editor.disabled_for_model']()}
                </Badge>
              ) : null}
              {writable && hasOverride ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={`routing-reset-${provider.id}`}
                  onClick={() => form.setFieldValue(`providers.${provider.id}`, {})}
                >
                  {m['dashboard.routing.editor.reset']()}
                </Button>
              ) : null}
            </div>
          );
        }}
      </form.Field>
    )}
  </form.Field>
);
