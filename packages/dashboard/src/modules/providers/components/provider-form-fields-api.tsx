import { m } from "@aio-proxy/i18n";
import { ProviderProtocol } from "@aio-proxy/types";

import { ProtocolLabel } from "@/components/protocol-label";
import { TagsInput } from "@/components/tags-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { useProviderForm } from "../hooks/use-provider-form";

import { ProviderFormMode } from "../constants";
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
    <div className="space-y-8">
      <section className="space-y-4" aria-labelledby="provider-api-basic-heading">
        <h2 id="provider-api-basic-heading" className="text-base font-semibold">
          {m["dashboard.providers.form.section_basic"]()}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ProviderCommonFields form={form} mode={mode} />
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="provider-api-connection-heading">
        <h2 id="provider-api-connection-heading" className="text-base font-semibold">
          {m["dashboard.providers.form.section_connection"]()}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div data-testid="provider-form-field-baseURL">
            <form.Field name="baseURL">
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
                  <p className="text-sm text-muted-foreground">
                    {mode === ProviderFormMode.Edit
                      ? m["dashboard.providers.form.api_key_helper_edit"]()
                      : m["dashboard.providers.form.api_key_helper_create"]()}
                  </p>
                </Field>
              )}
            </form.Field>
          </div>

          <div data-testid="provider-form-field-protocol" className="md:col-span-2">
            <form.Field name="protocol">
              {(field) => (
                <Field>
                  <Label>{m["dashboard.providers.form.label_protocol"]()}</Label>
                  <Select
                    value={field.state.value ?? ""}
                    onValueChange={(v) => field.handleChange(v as ProviderProtocol)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={m["dashboard.providers.form.placeholder_protocol"]()}>
                        {(protocol: ProviderProtocol | null) =>
                          protocol ? (
                            <ProtocolLabel protocol={protocol} showIcon />
                          ) : (
                            m["dashboard.providers.form.placeholder_protocol"]()
                          )
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(ProviderProtocol).map((protocol) => (
                        <SelectItem key={protocol} value={protocol}>
                          <ProtocolLabel protocol={protocol} showIcon />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
          </div>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="provider-api-models-heading">
        <h2 id="provider-api-models-heading" className="text-base font-semibold">
          {m["dashboard.providers.form.section_models_aliases"]()}
        </h2>
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
                <p className="text-sm text-muted-foreground">{m["dashboard.providers.form.models_helper"]()}</p>
              </Field>
            )}
          </form.Field>
        </div>

        <ProviderAliasFields form={form} mode={mode} open={aliasOpen} onOpenChange={onAliasOpenChange} />
      </section>
    </div>
  );
};
