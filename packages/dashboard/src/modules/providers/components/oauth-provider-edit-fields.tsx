import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthProviderEdit, OAuthProvider, ProviderTransforms } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';

import type { useOAuthProviderEditForm } from '../hooks/use-oauth-provider-edit-form';
import type { useOAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { ProviderFormMode } from '../lib/constants';
import { routingDraftNormalization } from '../lib/routing-draft-normalization';
import { OAuthAccountFields } from './oauth-account-fields';
import { OAuthProviderAliasFields } from './oauth-provider-alias-fields';
import { ProviderProxyField } from './provider-proxy-field';
import { ProviderRequestTransformsEditor } from './provider-request-transforms';

interface OAuthProviderEditFieldsProps {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly form: ReturnType<typeof useOAuthProviderEditForm>;
  readonly accountForm: ReturnType<typeof useOAuthProviderForm>;
  readonly aliasOpen: boolean;
  readonly onAliasOpenChange: (open: boolean) => void;
  readonly onReauthorize: () => void;
  readonly isReauthorizing: boolean;
  readonly transformsValid: boolean;
  readonly onTransformsValidityChange: (valid: boolean) => void;
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

export const OAuthProviderEditFields: React.FC<OAuthProviderEditFieldsProps> = ({
  provider,
  oauth,
  form,
  accountForm,
  aliasOpen,
  onAliasOpenChange,
  onReauthorize,
  isReauthorizing,
  transformsValid,
  onTransformsValidityChange,
}) => (
  <div className="space-y-8">
    <section className="space-y-4" aria-labelledby="provider-oauth-basic-heading">
      <h2 id="provider-oauth-basic-heading" className="text-base font-semibold">
        {m['dashboard.providers.form.section_basic']()}
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <form.Field name="name">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m['dashboard.providers.form.label_name']()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? ''}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <div data-testid="provider-form-field-priority">
          <form.Field name="priority">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.providers.form.label_priority']()}</Label>
                <Input
                  id={field.name}
                  type="number"
                  step="1"
                  value={field.state.value ?? ''}
                  onChange={(event) =>
                    field.handleChange(event.target.value === '' ? undefined : Number(event.target.value))
                  }
                />
                {routingDraftNotice('priority', field.state.value)}
              </Field>
            )}
          </form.Field>
        </div>
        <div data-testid="provider-form-field-weight">
          <form.Field name="weight">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.providers.form.label_weight']()}</Label>
                <Input
                  id={field.name}
                  type="number"
                  step="any"
                  value={field.state.value ?? ''}
                  onChange={(event) =>
                    field.handleChange(event.target.value === '' ? undefined : Number(event.target.value))
                  }
                />
                <FieldDescription>{m['dashboard.providers.form.description_weight']()}</FieldDescription>
                {routingDraftNotice('weight', field.state.value)}
              </Field>
            )}
          </form.Field>
        </div>
        <form.Field name="enabled">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m['dashboard.providers.form.label_enabled']()}</Label>
              <Switch
                id={field.name}
                checked={field.state.value}
                onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
              />
            </Field>
          )}
        </form.Field>
      </div>
    </section>

    <section className="space-y-4 border-t pt-6" aria-labelledby="provider-oauth-connection-heading">
      <h2 id="provider-oauth-connection-heading" className="text-base font-semibold">
        {m['dashboard.providers.form.section_connection']()}
      </h2>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-muted-foreground">{m['dashboard.providers.form.label_id']()}</dt>
          <dd className="mt-1 text-sm font-medium break-all">{provider.id}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.service_label']()}</dt>
          <dd className="mt-1 text-sm font-medium break-all">
            {provider.plugin} / {provider.capability}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.account_label']()}</dt>
          <dd className="mt-1 text-sm font-medium break-all">{oauth.accountLabel}</dd>
        </div>
      </dl>
      <OAuthAccountFields fields={oauth.form} form={accountForm} />
      <form.Field name="proxy">
        {(field) => <ProviderProxyField field={field} mode={ProviderFormMode.Edit} />}
      </form.Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.reauthorize_helper']()}</p>
        <Button type="button" variant="outline" onClick={onReauthorize} disabled={isReauthorizing || !transformsValid}>
          {m['dashboard.providers.oauth.reauthorize']()}
        </Button>
      </div>
    </section>

    <form.Field name="transforms">
      {(field) => {
        const transforms = field.state.value as ProviderTransforms | undefined;
        return (
          <ProviderRequestTransformsEditor
            value={transforms?.request ?? []}
            onChange={(request) => field.handleChange({ request })}
            onValidityChange={onTransformsValidityChange}
          />
        );
      }}
    </form.Field>

    <section className="space-y-4 border-t pt-6" aria-labelledby="provider-oauth-models-heading">
      <h2 id="provider-oauth-models-heading" className="text-base font-semibold">
        {m['dashboard.providers.form.section_models_aliases']()}
      </h2>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {oauth.models.map((model) => (
            <Badge key={model} variant="outline">
              {model}
            </Badge>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.models_readonly']()}</p>
      </div>
      <OAuthProviderAliasFields form={form} open={aliasOpen} onOpenChange={onAliasOpenChange} />
    </section>
  </div>
);
