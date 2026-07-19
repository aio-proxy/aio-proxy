import { m } from "@aio-proxy/i18n";
import type { DashboardOAuthProviderEdit, OAuthProvider } from "@aio-proxy/types";
import { Badge } from "@/components/ui/badge";
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
}

export const OAuthProviderEditFields: React.FC<OAuthProviderEditFieldsProps> = ({
  provider,
  oauth,
  form,
  accountForm,
  aliasOpen,
  onAliasOpenChange,
}) => (
  <div className="space-y-6">
    <div className="space-y-4">
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
      <Field>
        <Label htmlFor="oauth-provider-id">{m["dashboard.providers.form.label_id"]()}</Label>
        <Input id="oauth-provider-id" value={provider.id} disabled />
      </Field>
      <Field>
        <Label htmlFor="oauth-service">{m["dashboard.providers.oauth.service_label"]()}</Label>
        <Input id="oauth-service" value={`${provider.plugin} / ${provider.capability}`} disabled />
      </Field>
      <Field>
        <Label htmlFor="oauth-account">{m["dashboard.providers.oauth.account_label"]()}</Label>
        <Input id="oauth-account" value={oauth.accountLabel} disabled />
      </Field>
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
    </div>

    <section className="space-y-4">
      <h2 className="font-semibold">{m["dashboard.providers.oauth.account_fields_title"]()}</h2>
      <OAuthAccountFields fields={oauth.form} form={accountForm} />
      <p className="text-muted-foreground text-sm">{m["dashboard.providers.oauth.reauthorize_helper"]()}</p>
    </section>

    <section className="space-y-3">
      <h2 className="font-semibold">{m["dashboard.providers.oauth.models_title"]()}</h2>
      <div className="flex flex-wrap gap-2">
        {oauth.models.map((model) => (
          <Badge key={model} variant="outline">
            {model}
          </Badge>
        ))}
      </div>
      <p className="text-muted-foreground text-sm">{m["dashboard.providers.oauth.models_readonly"]()}</p>
    </section>

    <OAuthProviderAliasFields form={form} open={aliasOpen} onOpenChange={onAliasOpenChange} />
  </div>
);
