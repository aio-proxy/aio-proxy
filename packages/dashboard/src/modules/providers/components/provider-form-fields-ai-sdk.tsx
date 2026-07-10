import { m } from "@aio-proxy/i18n";
import type { AnyFieldApi } from "@tanstack/react-form";
import React from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TagsInput } from "@/components/ui/tags-input";
import { Textarea } from "@/components/ui/textarea";
import type { ProviderFormMode } from "../constants";
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

export const ProviderFormFieldsAiSdk: React.FC<Props> = ({ form, mode, aliasOpen, onAliasOpenChange }) => {
  return (
    <div className="space-y-4">
      <ProviderCommonFields form={form} mode={mode} />
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
                <Switch
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
