import { m } from "@aio-proxy/i18n";
import type { AliasTarget } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";
import { Trash2Icon } from "lucide-react";
import { type FC, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "../alias-editor";
import { aliasEditErrorMessage, aliasIssueMessage, type VisibleEditError } from "../alias-editor-copy";

type Props = {
  readonly alias: ProviderAlias;
  readonly aliasName: string;
  readonly variantName: string;
  readonly target: AliasTarget;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onChange: (target: AliasTarget) => void;
  readonly onRename: (name: string) => AliasEditResult;
  readonly onRemove: () => void;
};

export const ProviderVariantRow: FC<Props> = ({
  alias,
  aliasName,
  variantName,
  target,
  models,
  issues,
  onChange,
  onRename,
  onRemove,
}) => {
  const [editError, setEditError] = useState<VisibleEditError | null>(null);
  const form = useForm({
    defaultValues: { name: variantName, model: target.model, preserve: target.preserve } satisfies AliasDraft,
  });
  const issue = issues[0];
  const issueMessage = issue === undefined ? null : aliasIssueMessage(issue);
  const errorMessage = editError === null ? issueMessage : aliasEditErrorMessage(editError);
  const nameInvalid = editError === "name-required" || editError === "name-duplicate" || issue?.code.includes("name-");
  const targetInvalid = editError === "target-required" || issue?.code === "target-missing";
  const preserveCount = preserveReferenceCount(alias, target.model) - (target.preserve ? 1 : 0);
  const nameId = aliasControlId(aliasName, variantName);
  const targetId = `${nameId}-target`;
  const preserveId = `${nameId}-preserve`;

  const commitName = (name: string) => {
    const result = onRename(name);
    if (result.ok) {
      setEditError(null);
    } else if (result.code !== "alias-missing") {
      setEditError(result.code);
    }
  };

  return (
    <Card size="sm" data-testid="provider-variant-row">
      <CardHeader>
        <CardTitle>{variantName}</CardTitle>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={m["dashboard.providers.form.remove_variant"]()}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4 md:grid md:grid-cols-2">
          <form.Field name="name">
            {(field) => (
              <Field data-invalid={nameInvalid}>
                <FieldLabel htmlFor={nameId}>{m["dashboard.providers.form.variant_name"]()}</FieldLabel>
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
                <FieldLabel htmlFor={targetId}>{m["dashboard.providers.form.variant_target"]()}</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(model) => {
                    if (model === null) return;
                    field.handleChange(model);
                    setEditError(null);
                    onChange({ ...target, model });
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
                    onChange({ ...target, preserve: checked });
                  }}
                />
                <FieldLabel htmlFor={preserveId}>{m["dashboard.providers.form.variant_preserve"]()}</FieldLabel>
              </Field>
            )}
          </form.Field>
          {preserveCount > 0 && (
            <FieldDescription>
              {m["dashboard.providers.form.preserve_shared"]({ count: preserveCount })}
            </FieldDescription>
          )}
        </FieldGroup>
        {errorMessage !== null && <FieldError className="mt-3">{errorMessage}</FieldError>}
      </CardContent>
    </Card>
  );
};
