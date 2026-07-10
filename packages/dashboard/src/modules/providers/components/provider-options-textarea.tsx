import { m } from "@aio-proxy/i18n";
import type { AnyFieldApi } from "@tanstack/react-form";
import { type FC, useState } from "react";
import { z } from "zod";
import { Field, FieldError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const ProviderOptionsSchema = z.record(z.string(), z.unknown());

type ParsedProviderOptions = { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false };

export function parseProviderOptions(value: string): ParsedProviderOptions {
  try {
    const parsed = ProviderOptionsSchema.safeParse(JSON.parse(value));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false };
    }
    throw error;
  }
}

type Props = {
  readonly field: AnyFieldApi;
  readonly onOptionsValidityChange: (valid: boolean) => void;
};

export const ProviderOptionsTextarea: FC<Props> = ({ field, onOptionsValidityChange }) => {
  const [jsonError, setJsonError] = useState<string | null>(null);
  const errorId = `${field.name}-error`;
  const markInvalid = () => {
    setJsonError(m["dashboard.providers.form.options_json_error"]({}));
    onOptionsValidityChange(false);
  };

  return (
    <Field data-invalid={jsonError !== null}>
      <Label htmlFor={field.name}>{m["dashboard.providers.form.label_options"]()}</Label>
      <Textarea
        id={field.name}
        aria-describedby={jsonError === null ? undefined : errorId}
        aria-invalid={jsonError !== null}
        defaultValue={field.state.value ? JSON.stringify(field.state.value, null, 2) : ""}
        placeholder={m["dashboard.providers.form.placeholder_options"]({ '"baseURL":"..."': '{"baseURL":"..."}' })}
        onChange={(event) => {
          const value = event.target.value;
          if (value.trim() === "") {
            field.handleChange(undefined);
            setJsonError(null);
            onOptionsValidityChange(true);
            return;
          }

          const parsed = parseProviderOptions(value);
          if (!parsed.ok) {
            markInvalid();
            return;
          }
          field.handleChange(parsed.value);
          setJsonError(null);
          onOptionsValidityChange(true);
        }}
      />
      {jsonError !== null && <FieldError id={errorId}>{jsonError}</FieldError>}
    </Field>
  );
};
