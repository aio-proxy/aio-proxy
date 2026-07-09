import { m } from "@aio-proxy/i18n";
import { ProviderProtocol } from "@aio-proxy/types";
import { Link } from "@tanstack/react-router";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useProviderForm } from "../hooks/use-provider-form";

type Props = {
  form: ReturnType<typeof useProviderForm>;
  mode: "create" | "edit";
  providerId?: string | undefined;
};

export const ProviderFormFieldsApi: React.FC<Props> = ({ form, mode, providerId }) => {
  return (
    <div className="space-y-4">
      <div data-testid="provider-form-field-id">
        <form.Field name="id">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_id"]()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? ""}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={m["dashboard.providers.form.placeholder_id"]()}
                disabled={mode === "edit"}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-name">
        <form.Field name="name">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_name"]()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? ""}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={m["dashboard.providers.form.placeholder_name"]()}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-enabled">
        <form.Field name="enabled">
          {(field) => (
            <Field>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={field.name}
                  checked={field.state.value ?? true}
                  onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
                />
                <Label htmlFor={field.name}>{m["dashboard.providers.form.label_enabled"]()}</Label>
              </div>
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-weight">
        <form.Field name="weight">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_weight"]()}</Label>
              <Input
                id={field.name}
                type="number"
                value={field.state.value ?? ""}
                onChange={(e) => field.handleChange(e.target.value === "" ? undefined : Number(e.target.value))}
              />
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
                  {Object.values(ProviderProtocol).map((protocol) => (
                    <SelectItem key={protocol} value={protocol}>
                      {protocol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
      </div>
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
                {mode === "edit"
                  ? m["dashboard.providers.form.api_key_helper_edit"]()
                  : m["dashboard.providers.form.api_key_helper_create"]()}
              </p>
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-models">
        <form.Field name="models">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_models"]()}</Label>
              <Input
                id={field.name}
                value={(field.state.value ?? []).join(", ")}
                onChange={(e) =>
                  field.handleChange(
                    e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  )
                }
                placeholder={m["dashboard.providers.form.placeholder_models"]()}
              />
              <p className="text-muted-foreground text-sm">{m["dashboard.providers.form.models_helper"]()}</p>
            </Field>
          )}
        </form.Field>
      </div>
      {mode === "edit" && providerId && (
        <Link
          to="/providers/$id/aliases"
          params={{ id: providerId }}
          className="text-muted-foreground text-sm underline"
        >
          {m["dashboard.providers.actions.edit_aliases"]()}
        </Link>
      )}
    </div>
  );
};
