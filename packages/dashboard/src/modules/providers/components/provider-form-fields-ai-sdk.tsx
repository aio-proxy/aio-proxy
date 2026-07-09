import { m } from "@aio-proxy/i18n";
import type { AnyFieldApi } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { useProviderForm } from "../hooks/use-provider-form";

type Props = {
  form: ReturnType<typeof useProviderForm>;
  mode: "create" | "edit";
  providerId?: string | undefined;
};

const OptionsTextarea: React.FC<{ field: AnyFieldApi }> = ({ field }) => {
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  return (
    <Field>
      <Label htmlFor={field.name}>{m["dashboard.providers.form.label_options"]()}</Label>
      <Textarea
        id={field.name}
        defaultValue={field.state.value ? JSON.stringify(field.state.value, null, 2) : ""}
        placeholder={m["dashboard.providers.form.placeholder_options"]({ '"baseURL":"..."': '{"baseURL":"..."}' })}
        onBlur={(e) => {
          if (e.target.value === "") {
            field.handleChange(undefined);
            setJsonError(null);
            return;
          }
          try {
            field.handleChange(JSON.parse(e.target.value) as Record<string, unknown>);
            setJsonError(null);
          } catch {
            setJsonError(m["dashboard.providers.form.options_json_error"]({}));
          }
        }}
      />
      {jsonError && <p className="text-destructive text-sm">{jsonError}</p>}
    </Field>
  );
};

export const ProviderFormFieldsAiSdk: React.FC<Props> = ({ form, mode, providerId }) => {
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
      <div data-testid="provider-form-field-packageName">
        <form.Field name="packageName">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_package_name"]()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? "@ai-sdk/openai-compatible"}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={m["dashboard.providers.form.placeholder_package_name"]()}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-options">
        <form.Field name="options">{(field) => <OptionsTextarea field={field} />}</form.Field>
      </div>
      <div data-testid="provider-form-field-parseReasoningContent">
        <form.Field name="parseReasoningContent">
          {(field) => (
            <Field>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={field.name}
                  checked={field.state.value ?? false}
                  onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
                />
                <Label htmlFor={field.name}>{m["dashboard.providers.form.label_parse_reasoning"]()}</Label>
              </div>
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
