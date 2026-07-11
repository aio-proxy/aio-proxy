import { m } from "@aio-proxy/i18n";
import { kebabCase } from "es-toolkit/string";
import type React from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ProviderFormMode } from "../constants";
import type { useProviderForm } from "../hooks/use-provider-form";

type Props = {
  form: ReturnType<typeof useProviderForm>;
  mode: ProviderFormMode;
};

export const ProviderCommonFields: React.FC<Props> = ({ form, mode }) => {
  return (
    <>
      <div data-testid="provider-form-field-name">
        <form.Field name="name">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_name"]()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? ""}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={() => {
                  field.handleBlur();
                  if (mode === ProviderFormMode.Create) {
                    const currentId = form.getFieldValue("id");
                    if (!currentId || currentId.trim() === "") {
                      const generated = kebabCase(field.state.value ?? "");
                      if (generated !== "") {
                        form.setFieldValue("id", generated);
                      }
                    }
                  }
                }}
                placeholder={m["dashboard.providers.form.placeholder_name"]()}
              />
            </Field>
          )}
        </form.Field>
      </div>
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
                disabled={mode === ProviderFormMode.Edit}
              />
            </Field>
          )}
        </form.Field>
      </div>
      <div data-testid="provider-form-field-enabled">
        <form.Field name="enabled">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m["dashboard.providers.form.label_enabled"]()}</Label>
              <Switch
                id={field.name}
                checked={field.state.value ?? true}
                onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
              />
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
    </>
  );
};
