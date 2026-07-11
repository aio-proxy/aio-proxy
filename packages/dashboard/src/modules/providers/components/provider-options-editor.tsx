import { m } from "@aio-proxy/i18n";
import type { AnyFieldApi } from "@tanstack/react-form";
import { type FC, useEffect, useRef, useState } from "react";
import { JsonEditor, type JsonEditorValidation, type JsonValue } from "@/components/json-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import type { UseProviderOptionsSchemaResult } from "../hooks/use-provider-options-schema";

export const isProviderOptionsObject = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> | undefined => {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type Props = {
  readonly field: AnyFieldApi;
  readonly schemaState: UseProviderOptionsSchemaResult;
  readonly onValidityChange: (valid: boolean) => void;
};

const initialValidation: JsonEditorValidation = {
  valid: true,
  syntaxValid: true,
  pending: false,
  markers: [],
};

export const ProviderOptionsEditor: FC<Props> = ({ field, schemaState, onValidityChange }) => {
  const [editorValue, setEditorValue] = useState<JsonValue | undefined>(field.state.value);
  const [rootValid, setRootValid] = useState(true);
  const [validation, setValidation] = useState(initialValidation);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const valid = rootValid && validation.valid;
  const lastValidity = useRef(valid);

  useEffect(() => {
    if (lastValidity.current === valid) return;
    lastValidity.current = valid;
    onValidityChange(valid);
  }, [onValidityChange, valid]);

  useEffect(() => {
    if (schemaState.phase === "install_required") setInstallDialogOpen(true);
  }, [schemaState.phase]);

  const packageName = schemaState.packageName ?? "";
  let helper: string | null = null;
  if (schemaState.phase === "checking") {
    helper = m["dashboard.providers.form.options_checking_package"]({ packageName });
  } else if (schemaState.phase === "installing") {
    helper = m["dashboard.providers.form.options_installing_trusted_package"]({ packageName });
  } else if (schemaState.phase === "loading_schema") {
    helper = m["dashboard.providers.form.options_schema_loading"]();
  } else if (schemaState.phase === "schema_unavailable" || schemaState.phase === "schema_error") {
    helper = m["dashboard.providers.form.options_schema_unavailable"]();
  } else if (schemaState.phase === "install_error") {
    helper = m["dashboard.providers.form.options_install_failure"]();
  } else if (schemaState.warnings.length > 0) {
    helper = m["dashboard.providers.form.options_schema_warning_summary"]({ count: schemaState.warnings.length });
  }

  const hasSchemaError = validation.markers.some(({ severity }) => severity === "error");
  const error = !validation.syntaxValid
    ? m["dashboard.providers.form.options_json_error"]({})
    : !rootValid
      ? m["dashboard.providers.form.options_object_error"]()
      : hasSchemaError
        ? m["dashboard.providers.form.options_schema_error"]()
        : null;

  return (
    <Field data-invalid={!valid}>
      <Label htmlFor={field.name}>{m["dashboard.providers.form.label_options"]()}</Label>
      <JsonEditor
        id={field.name}
        value={editorValue}
        schema={schemaState.schema}
        onValueChange={(value) => {
          setEditorValue(value);
          const nextRootValid = isProviderOptionsObject(value);
          setRootValid(nextRootValid);
          if (nextRootValid) field.handleChange(value);
        }}
        onValidationChange={setValidation}
      />
      {helper !== null && <FieldDescription>{helper}</FieldDescription>}
      {schemaState.phase === "install_required" && (
        <Button type="button" variant="outline" onClick={() => setInstallDialogOpen(true)}>
          {m["dashboard.providers.form.options_install_package"]()}
        </Button>
      )}
      {error !== null && <FieldError>{error}</FieldError>}
      <AlertDialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m["dashboard.providers.form.options_install_dialog_title"]()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m["dashboard.providers.form.options_install_dialog_description"]({ packageName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m["dashboard.providers.form.options_install_dialog_cancel"]()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setInstallDialogOpen(false);
                schemaState.confirmInstall();
              }}
            >
              {m["dashboard.providers.form.options_install_dialog_confirm"]()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Field>
  );
};
