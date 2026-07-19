import type { AliasConfig } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";
import { normalizeAliasName } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";
import { type FC, useState } from "react";

import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import {
  type AliasDraft,
  type AliasEditorIssue,
  type AliasEditResult,
  aliasControlId,
  type ProviderAlias,
  preserveReferenceCount,
} from "../../alias-editor";
import { aliasEditErrorMessage, aliasIssueMessage, type VisibleEditError } from "../../alias-editor-copy";

type Props = {
  readonly alias: ProviderAlias;
  readonly aliasName: string;
  readonly config: AliasConfig;
  readonly models: readonly string[];
  readonly issue: AliasEditorIssue | undefined;
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onRename: (name: string) => AliasEditResult;
};

export const ProviderAliasConfigFields: FC<Props> = ({
  alias,
  aliasName,
  config,
  models,
  issue,
  onAliasChange,
  onRename,
}) => {
  const [editError, setEditError] = useState<VisibleEditError | null>(null);
  const form = useForm({
    defaultValues: { name: aliasName, model: config.model, preserve: config.preserve } satisfies AliasDraft,
  });
  const errorMessage =
    editError === null ? (issue ? aliasIssueMessage(issue) : null) : aliasEditErrorMessage(editError);
  const nameInvalid =
    editError === "name-required" ||
    editError === "name-duplicate" ||
    issue?.code === "alias-name-required" ||
    issue?.code === "alias-name-duplicate" ||
    issue?.code === "preserved-route-conflict";
  const targetInvalid = editError === "target-required" || issue?.code === "target-missing";
  const preserveCount = preserveReferenceCount(alias, config.model) - (config.preserve ? 1 : 0);
  const nameId = aliasControlId(aliasName);
  const targetId = `${nameId}-target`;
  const preserveId = `${nameId}-preserve`;

  const commitName = (name: string) => {
    const result = onRename(name);
    if (result.ok) {
      setEditError(null);
      form.setFieldValue("name", normalizeAliasName(name));
    } else if (result.code !== "alias-missing") {
      setEditError(result.code);
    }
  };

  return (
    <>
      <FieldGroup className="gap-4 md:grid md:grid-cols-2">
        <form.Field name="name">
          {(field) => (
            <Field data-invalid={nameInvalid}>
              <FieldLabel htmlFor={nameId}>{m["dashboard.providers.form.alias_name"]()}</FieldLabel>
              <Input
                id={nameId}
                value={field.state.value}
                aria-invalid={nameInvalid}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  setEditError(null);
                }}
                onBlur={() => {
                  field.handleBlur();
                  commitName(field.state.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitName(field.state.value);
                  }
                }}
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="model">
          {(field) => (
            <Field data-invalid={targetInvalid}>
              <FieldLabel htmlFor={targetId}>{m["dashboard.providers.form.alias_target"]()}</FieldLabel>
              <Select
                value={field.state.value}
                onValueChange={(model) => {
                  if (model === null) return;
                  field.handleChange(model);
                  setEditError(null);
                  onAliasChange({ ...alias, [aliasName]: { ...config, model } });
                }}
              >
                <SelectTrigger id={targetId} className="w-full" aria-invalid={targetInvalid}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {models.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="preserve">
          {(field) => (
            <Field orientation="horizontal">
              <Switch
                id={preserveId}
                checked={field.state.value}
                onCheckedChange={(preserve) => {
                  const checked = Boolean(preserve);
                  field.handleChange(checked);
                  onAliasChange({ ...alias, [aliasName]: { ...config, preserve: checked } });
                }}
              />
              <FieldLabel htmlFor={preserveId}>{m["dashboard.providers.form.alias_preserve"]()}</FieldLabel>
            </Field>
          )}
        </form.Field>
        <FieldDescription>{m["dashboard.providers.form.preserve_helper"]()}</FieldDescription>
        {preserveCount > 0 && (
          <FieldDescription>{m["dashboard.providers.form.preserve_shared"]({ count: preserveCount })}</FieldDescription>
        )}
      </FieldGroup>
      {errorMessage !== null && <FieldError>{errorMessage}</FieldError>}
    </>
  );
};
