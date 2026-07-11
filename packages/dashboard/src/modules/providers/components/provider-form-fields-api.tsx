import { m } from "@aio-proxy/i18n";
import type { ProviderProtocol } from "@aio-proxy/types";
import { TagsInput } from "@/components/tags-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { API_PROVIDER_PROTOCOLS, ProviderFormMode } from "../constants";
import type { useProviderForm } from "../hooks/use-provider-form";
import { ProviderAliasFields } from "./provider-alias";
import { ProviderCommonFields } from "./provider-common-fields";

type Props = {
  form: ReturnType<typeof useProviderForm>;
  mode: ProviderFormMode;
  providerId?: string | undefined;
  aliasOpen: boolean;
  onAliasOpenChange: (open: boolean) => void;
};

export const ProviderFormFieldsApi: React.FC<Props> = ({ form, mode, aliasOpen, onAliasOpenChange }) => {
  return (
    <div className="space-y-4">
      <ProviderCommonFields form={form} mode={mode} />

      <div data-testid="provider-form-field-baseUrl">
        <form.Field name="baseUrl">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_base_url"]()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? ""}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={m["dashboard.providers.form.placeholder_base_url"]()}
              />
            </Field>
          )}
        </form.Field>
      </div>

      <div data-testid="provider-form-field-apiKey">
        <form.Field name="apiKey">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_api_key"]()}</Label>
              <Input
                id={field.name}
                type="password"
                value={field.state.value ?? ""}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={m["dashboard.providers.form.placeholder_api_key"]()}
              />
              <p className="text-muted-foreground text-sm">
                {mode === ProviderFormMode.Edit
                  ? m["dashboard.providers.form.api_key_helper_edit"]()
                  : m["dashboard.providers.form.api_key_helper_create"]()}
              </p>
            </Field>
          )}
        </form.Field>
      </div>

      <div data-testid="provider-form-field-protocol">
        <form.Field name="protocol">
          {(field) => (
            <Field>
              <Label>{m["dashboard.providers.form.label_protocol"]()}</Label>
              <Select value={field.state.value ?? ""} onValueChange={(v) => field.handleChange(v as ProviderProtocol)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {API_PROVIDER_PROTOCOLS.map((protocol) => (
                    <SelectItem key={protocol.value} value={protocol.value} className="flex items-center gap-2">
                      <protocol.icon />
                      {protocol.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
      </div>

      <div data-testid="provider-form-field-models">
        <form.Field name="models">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_models"]()}</Label>
              <TagsInput
                id={field.name}
                value={field.state.value ?? []}
                onValueChange={(next) => field.handleChange(next)}
                placeholder={m["dashboard.providers.form.placeholder_models"]()}
                removeLabel={(model) => m["dashboard.providers.form.remove_model"]({ model })}
              />
              <p className="text-muted-foreground text-sm">{m["dashboard.providers.form.models_helper"]()}</p>
            </Field>
          )}
        </form.Field>
      </div>

      <ProviderAliasFields form={form} mode={mode} open={aliasOpen} onOpenChange={onAliasOpenChange} />
    </div>
  );
};
