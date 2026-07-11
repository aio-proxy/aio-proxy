import { m } from "@aio-proxy/i18n";
import type React from "react";
import { useEffect, useRef } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TagsInput } from "@/components/ui/tags-input";
import type { ProviderFormMode } from "../constants";
import type { useProviderForm } from "../hooks/use-provider-form";
import { useProviderOptionsSchema } from "../hooks/use-provider-options-schema";
import { ProviderAliasFields } from "./provider-alias";
import { ProviderCommonFields } from "./provider-common-fields";
import { ProviderOptionsEditor } from "./provider-options-editor";

const DEFAULT_AI_SDK_PACKAGE = "@ai-sdk/openai-compatible";

type Props = {
  form: ReturnType<typeof useProviderForm>;
  mode: ProviderFormMode;
  providerId?: string | undefined;
  aliasOpen: boolean;
  onAliasOpenChange: (open: boolean) => void;
  onOptionsValidityChange: (valid: boolean) => void;
};

export const ProviderFormFieldsAiSdk: React.FC<Props> = ({
  form,
  mode,
  aliasOpen,
  onAliasOpenChange,
  onOptionsValidityChange,
}) => {
  const schemaState = useProviderOptionsSchema();
  const initialPackageName = useRef(form.getFieldValue("packageName") ?? DEFAULT_AI_SDK_PACKAGE).current;

  useEffect(() => {
    schemaState.commitPackage(initialPackageName);
  }, [initialPackageName, schemaState.commitPackage]);

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
                value={field.state.value ?? DEFAULT_AI_SDK_PACKAGE}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  schemaState.changePackage(event.target.value);
                }}
                onBlur={() => schemaState.commitPackage(field.state.value ?? DEFAULT_AI_SDK_PACKAGE)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    schemaState.commitPackage(field.state.value ?? DEFAULT_AI_SDK_PACKAGE);
                  }
                }}
                placeholder={m["dashboard.providers.form.placeholder_package_name"]()}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-options">
        <form.Field name="options">
          {(field) => (
            <ProviderOptionsEditor field={field} schemaState={schemaState} onValidityChange={onOptionsValidityChange} />
          )}
        </form.Field>
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
