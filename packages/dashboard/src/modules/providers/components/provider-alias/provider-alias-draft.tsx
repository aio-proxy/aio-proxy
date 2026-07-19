import { m } from "@aio-proxy/i18n";
import { useForm } from "@tanstack/react-form";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { type FC, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import type { AliasDraft, AliasEditResult } from "../../alias-editor";

import { aliasEditErrorMessage, type VisibleEditError } from "../../alias-editor-copy";

type Props = {
  readonly id: string;
  readonly models: readonly string[];
  readonly onCommit: (draft: AliasDraft) => AliasEditResult;
  readonly onDiscard: () => void;
  readonly onDirtyChange: (id: string, dirty: boolean) => void;
};

export const ProviderAliasDraft: FC<Props> = ({ id, models, onCommit, onDiscard, onDirtyChange }) => {
  const initialModel = models[0] ?? "";
  const [error, setError] = useState<VisibleEditError | null>(null);
  const defaultValues: AliasDraft = { name: "", model: initialModel, preserve: false };
  const form = useForm({
    defaultValues,
    onSubmit: ({ value }) => {
      const result = onCommit(value);
      if (result.ok) {
        setError(null);
      } else if (result.code !== "alias-missing") {
        setError(result.code);
        document.getElementById(result.code === "target-required" ? targetId : nameId)?.focus();
      }
    },
  });
  const nameId = `provider-alias-draft-${id}-name`;
  const targetId = `provider-alias-draft-${id}-target`;

  const reportDirty = (next: AliasDraft) =>
    onDirtyChange(id, next.name.trim() !== "" || next.model !== initialModel || next.preserve);

  return (
    <Card size="sm" data-testid="provider-alias-draft">
      <CardHeader>
        <CardTitle>{m["dashboard.providers.form.alias_draft_title"]()}</CardTitle>
        <CardAction>
          <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
            <Trash2Icon data-icon="inline-start" />
            {m["dashboard.providers.form.discard_draft"]()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          <form.Field name="name">
            {(field) => (
              <Field data-invalid={error === "name-required" || error === "name-duplicate"}>
                <FieldLabel htmlFor={nameId}>{m["dashboard.providers.form.alias_name"]()}</FieldLabel>
                <Input
                  id={nameId}
                  autoFocus
                  value={field.state.value}
                  aria-invalid={error === "name-required" || error === "name-duplicate"}
                  onChange={(event) => {
                    const next = { ...form.state.values, name: event.target.value };
                    field.handleChange(event.target.value);
                    reportDirty(next);
                    setError(null);
                  }}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="model">
            {(field) => (
              <Field data-invalid={error === "target-required"}>
                <FieldLabel htmlFor={targetId}>{m["dashboard.providers.form.alias_target"]()}</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(model) => {
                    if (model === null) return;
                    const next = { ...form.state.values, model };
                    field.handleChange(model);
                    reportDirty(next);
                    setError(null);
                  }}
                >
                  <SelectTrigger id={targetId} className="w-full" aria-invalid={error === "target-required"}>
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
                  id={`provider-alias-draft-${id}-preserve`}
                  checked={field.state.value}
                  onCheckedChange={(preserve) => {
                    const next = { ...form.state.values, preserve: Boolean(preserve) };
                    field.handleChange(Boolean(preserve));
                    reportDirty(next);
                  }}
                />
                <FieldLabel htmlFor={`provider-alias-draft-${id}-preserve`}>
                  {m["dashboard.providers.form.alias_preserve"]()}
                </FieldLabel>
              </Field>
            )}
          </form.Field>
          {error !== null && <FieldError>{aliasEditErrorMessage(error)}</FieldError>}
        </FieldGroup>
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="button" size="sm" onClick={() => void form.handleSubmit()}>
          <PlusIcon data-icon="inline-start" />
          {m["dashboard.providers.form.add_draft"]()}
        </Button>
      </CardFooter>
    </Card>
  );
};
