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

export const providerOptionsAreValid = (
  rootValid: boolean,
  validation: JsonEditorValidation,
  phase: UseProviderOptionsSchemaResult["phase"],
  schema: UseProviderOptionsSchemaResult["schema"],
  schemaResolution: UseProviderOptionsSchemaResult["schemaResolution"],
  value?: JsonValue,
) =>
  rootValid &&
  !(value === undefined && Array.isArray(schema?.required) && schema.required.length > 0) &&
  validation.valid &&
  Object.is(validation.schema, schema) &&
  (phase === "ready" || phase === "schema_unavailable" || phase === "install_error") &&
  (schemaResolution === "unavailable" || (schemaResolution === "ready" && schema !== undefined));

export const canConfirmProviderInstall = (
  dialogPackage: string | null,
  phase: UseProviderOptionsSchemaResult["phase"],
  currentPackage: string | null,
) => dialogPackage !== null && phase === "install_required" && currentPackage === dialogPackage;

export const canRequestProviderInstall = (phase: UseProviderOptionsSchemaResult["phase"]) =>
  phase === "install_required" || phase === "install_deferred" || phase === "install_error";

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
  schema: undefined,
};

export const ProviderOptionsEditor: FC<Props> = ({ field, schemaState, onValidityChange }) => {
  const [editorValue, setEditorValue] = useState<JsonValue | undefined>(field.state.value);
  const [validation, setValidation] = useState(initialValidation);
  const [installDialogPackage, setInstallDialogPackage] = useState<string | null>(null);
  const rootValid = isProviderOptionsObject(editorValue);
  const requiredRootMissing =
    editorValue === undefined && Array.isArray(schemaState.schema?.required) && schemaState.schema.required.length > 0;
  const valid = providerOptionsAreValid(
    rootValid,
    validation,
    schemaState.phase,
    schemaState.schema,
    schemaState.schemaResolution,
    editorValue,
  );
  const lastValidity = useRef(valid);

  useEffect(() => {
    if (lastValidity.current === valid) return;
    lastValidity.current = valid;
    onValidityChange(valid);
  }, [onValidityChange, valid]);

  const packageName = schemaState.packageName ?? "";
  const installRequiredPackage = schemaState.phase === "install_required" ? schemaState.packageName : null;

  useEffect(() => {
    setInstallDialogPackage(installRequiredPackage);
  }, [installRequiredPackage]);

  let helper: string | null = null;
  if (schemaState.phase === "checking") {
    helper = m["dashboard.providers.form.options_checking_package"]({ packageName });
  } else if (schemaState.phase === "installing") {
    helper = m["dashboard.providers.form.options_installing_trusted_package"]({ packageName });
  } else if (schemaState.phase === "install_deferred") {
    helper = m["dashboard.providers.form.options_install_package"]();
  } else if (schemaState.phase === "loading_schema") {
    helper = m["dashboard.providers.form.options_schema_loading"]();
  } else if (schemaState.phase === "schema_unavailable") {
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
      : hasSchemaError || requiredRootMissing
        ? m["dashboard.providers.form.options_schema_error"]()
        : schemaState.schemaResolution === "error"
          ? m["dashboard.providers.form.options_schema_load_error"]()
          : null;
  const errorId = `${field.name}-error`;
  const dialogOpen =
    installDialogPackage !== null && installRequiredPackage !== null && installDialogPackage === installRequiredPackage;

  return (
    <Field data-invalid={!valid}>
      <Label htmlFor={field.name}>{m["dashboard.providers.form.label_options"]()}</Label>
      <JsonEditor
        id={field.name}
        value={editorValue}
        schema={schemaState.schema}
        externalInvalid={!rootValid || requiredRootMissing || schemaState.schemaResolution === "error"}
        errorDescriptionId={error === null ? undefined : errorId}
        onValueChange={(value) => {
          setEditorValue(value);
          const nextRootValid = isProviderOptionsObject(value);
          if (nextRootValid) field.handleChange(value);
        }}
        onValidationChange={setValidation}
      />
      {helper !== null && <FieldDescription>{helper}</FieldDescription>}
      {canRequestProviderInstall(schemaState.phase) && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (schemaState.phase === "install_required") {
              setInstallDialogPackage(installRequiredPackage);
            } else {
              schemaState.requestInstall();
            }
          }}
        >
          {m["dashboard.providers.form.options_install_package"]()}
        </Button>
      )}
      {error !== null && <FieldError id={errorId}>{error}</FieldError>}
      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => setInstallDialogPackage(open ? installRequiredPackage : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m["dashboard.providers.form.options_install_dialog_title"]()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m["dashboard.providers.form.options_install_dialog_description"]({
                packageName: installDialogPackage ?? packageName,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m["dashboard.providers.form.options_install_dialog_cancel"]()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const confirmedPackage = installDialogPackage;
                setInstallDialogPackage(null);
                if (canConfirmProviderInstall(confirmedPackage, schemaState.phase, schemaState.packageName)) {
                  schemaState.confirmInstall();
                }
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
