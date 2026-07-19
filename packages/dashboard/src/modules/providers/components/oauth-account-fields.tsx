import { getLocale, m } from "@aio-proxy/i18n";
import { resolveLocalizedText } from "@aio-proxy/plugin-sdk";
import type { DashboardOAuthFormField } from "@aio-proxy/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { useOAuthProviderForm } from "../hooks/use-oauth-provider-form";

interface OAuthAccountFieldsProps {
  readonly fields: readonly DashboardOAuthFormField[];
  readonly form: ReturnType<typeof useOAuthProviderForm>;
}

const optionValue = (value: string | number | boolean) => JSON.stringify(value);
const validJson = (value: string) => {
  if (value === "") return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

export const OAuthAccountFields: React.FC<OAuthAccountFieldsProps> = ({ fields, form }) => (
  <form.Field name="publicValues">
    {(publicField) => (
      <form.Field name="secrets">
        {(secretField) => (
          <form.Field name="jsonValues">
            {(jsonField) => {
              const combined = { ...publicField.state.value, ...secretField.state.value };
              return (
                <div className="space-y-4">
                  {fields.map((field) => {
                    if (field.when !== undefined && combined[field.when.key] !== field.when.equals) return null;
                    const label = resolveLocalizedText(field.label, getLocale());
                    const description =
                      field.description === undefined
                        ? undefined
                        : resolveLocalizedText(field.description, getLocale());
                    const current = publicField.state.value[field.key];
                    const setPublic = (value: unknown) =>
                      publicField.handleChange({ ...publicField.state.value, [field.key]: value });
                    if (field.type === "secret") {
                      return (
                        <Field key={field.key}>
                          <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
                          <Input
                            id={`oauth-${field.key}`}
                            type="password"
                            value={secretField.state.value[field.key] ?? ""}
                            onChange={(event) =>
                              secretField.handleChange({ ...secretField.state.value, [field.key]: event.target.value })
                            }
                          />
                          {field.configured ? (
                            <>
                              <p className="text-muted-foreground text-sm">
                                {m["dashboard.providers.oauth.secret_configured"]()}
                              </p>
                              <form.Field name="clearSecrets">
                                {(clearField) => (
                                  <Label className="flex items-center gap-2">
                                    <Checkbox
                                      checked={clearField.state.value.includes(field.key)}
                                      onCheckedChange={(checked) =>
                                        clearField.handleChange(
                                          checked
                                            ? [...clearField.state.value, field.key]
                                            : clearField.state.value.filter((key) => key !== field.key),
                                        )
                                      }
                                    />
                                    {m["dashboard.providers.oauth.clear_secret"]()}
                                  </Label>
                                )}
                              </form.Field>
                            </>
                          ) : null}
                        </Field>
                      );
                    }
                    if (field.type === "boolean") {
                      return (
                        <Field key={field.key} orientation="horizontal">
                          <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
                          <Switch
                            id={`oauth-${field.key}`}
                            checked={Boolean(current ?? field.defaultValue)}
                            onCheckedChange={(checked) => setPublic(Boolean(checked))}
                          />
                        </Field>
                      );
                    }
                    if (field.type === "select") {
                      return (
                        <Field key={field.key}>
                          <Label>{label}</Label>
                          <Select
                            value={current === undefined ? "" : optionValue(current as string | number | boolean)}
                            onValueChange={(value) => setPublic(JSON.parse(value))}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {field.options.map((option) => (
                                <SelectItem key={optionValue(option.value)} value={optionValue(option.value)}>
                                  {resolveLocalizedText(option.label, getLocale())}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      );
                    }
                    if (field.type === "json") {
                      const value =
                        jsonField.state.value[field.key] ?? (current === undefined ? "" : JSON.stringify(current));
                      const invalid = !validJson(value);
                      return (
                        <Field key={field.key}>
                          <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
                          <Textarea
                            id={`oauth-${field.key}`}
                            value={value}
                            aria-invalid={invalid}
                            onChange={(event) => {
                              const next = event.target.value;
                              jsonField.handleChange({ ...jsonField.state.value, [field.key]: next });
                              if (validJson(next)) setPublic(next === "" ? undefined : JSON.parse(next));
                            }}
                          />
                          {invalid ? (
                            <p className="text-destructive text-sm">
                              {m["dashboard.providers.form.options_json_error"]()}
                            </p>
                          ) : null}
                        </Field>
                      );
                    }
                    return (
                      <Field key={field.key}>
                        <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
                        <Input
                          id={`oauth-${field.key}`}
                          type={field.type === "number" ? "number" : "text"}
                          value={typeof current === "string" || typeof current === "number" ? current : ""}
                          placeholder={
                            field.placeholder === undefined
                              ? undefined
                              : resolveLocalizedText(field.placeholder, getLocale())
                          }
                          onChange={(event) =>
                            setPublic(
                              field.type === "number"
                                ? event.target.value === ""
                                  ? undefined
                                  : Number(event.target.value)
                                : event.target.value,
                            )
                          }
                        />
                        {description === undefined ? null : (
                          <p className="text-muted-foreground text-sm">{description}</p>
                        )}
                      </Field>
                    );
                  })}
                </div>
              );
            }}
          </form.Field>
        )}
      </form.Field>
    )}
  </form.Field>
);
