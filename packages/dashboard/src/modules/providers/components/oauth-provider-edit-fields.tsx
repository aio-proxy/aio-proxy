import type { DashboardOAuthProviderEdit, OAuthProvider } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import type { useOAuthProviderEditForm } from "../hooks/use-oauth-provider-edit-form";
import type { useOAuthProviderForm } from "../hooks/use-oauth-provider-form";

import { OAuthAccountFields } from "./oauth-account-fields";
import { OAuthProviderAliasFields } from "./oauth-provider-alias-fields";

interface OAuthProviderEditFieldsProps {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly form: ReturnType<typeof useOAuthProviderEditForm>;
  readonly accountForm: ReturnType<typeof useOAuthProviderForm>;
  readonly aliasOpen: boolean;
  readonly onAliasOpenChange: (open: boolean) => void;
  readonly onReauthorize: () => void;
  readonly isReauthorizing: boolean;
}

export const OAuthProviderEditFields: React.FC<OAuthProviderEditFieldsProps> = ({
  provider,
  oauth,
  form,
  accountForm,
  aliasOpen,
  onAliasOpenChange,
  onReauthorize,
  isReauthorizing,
}) => (
  <div className="space-y-8">
    <section className="space-y-4" aria-labelledby="provider-oauth-basic-heading">
      <h2 id="provider-oauth-basic-heading" className="text-base font-semibold">
        {m["dashboard.providers.form.section_basic"]()}
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <form.Field name="name">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_name"]()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? ""}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="weight">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_weight"]()}</Label>
              <Input
                id={field.name}
                type="number"
                value={field.state.value ?? ""}
                onChange={(event) =>
                  field.handleChange(event.target.value === "" ? undefined : Number(event.target.value))
                }
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="enabled">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_enabled"]()}</Label>
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
        {m["dashboard.providers.form.section_connection"]()}
      </h2>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-muted-foreground">{m["dashboard.providers.form.label_id"]()}</dt>
          <dd className="mt-1 text-sm font-medium break-all">{provider.id}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{m["dashboard.providers.oauth.service_label"]()}</dt>
          <dd className="mt-1 text-sm font-medium break-all">
            {provider.plugin} / {provider.capability}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">{m["dashboard.providers.oauth.account_label"]()}</dt>
          <dd className="mt-1 text-sm font-medium break-all">{oauth.accountLabel}</dd>
        </div>
      </dl>
      <OAuthAccountFields fields={oauth.form} form={accountForm} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{m["dashboard.providers.oauth.reauthorize_helper"]()}</p>
        <Button type="button" variant="outline" onClick={onReauthorize} disabled={isReauthorizing}>
          {m["dashboard.providers.oauth.reauthorize"]()}
        </Button>
      </div>
    </section>

    <section className="space-y-4 border-t pt-6" aria-labelledby="provider-oauth-models-heading">
      <h2 id="provider-oauth-models-heading" className="text-base font-semibold">
        {m["dashboard.providers.form.section_models_aliases"]()}
      </h2>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {oauth.models.map((model) => (
            <Badge key={model} variant="outline">
              {model}
            </Badge>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{m["dashboard.providers.oauth.models_readonly"]()}</p>
      </div>
      <OAuthProviderAliasFields form={form} open={aliasOpen} onOpenChange={onAliasOpenChange} />
    </section>
  </div>
);
