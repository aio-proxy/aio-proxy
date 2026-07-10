import { m } from "@aio-proxy/i18n";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { aliasEditorIssues, aliasSummary, type ProviderAlias, serializeAlias } from "../../alias-editor";
import { aliasSummaryMessage } from "../../alias-editor-copy";
import { ProviderFormMode } from "../../constants";
import type { useProviderForm } from "../../hooks/use-provider-form";
import { ProviderAliasDrawer } from "./provider-alias-drawer";

type Props = {
  readonly form: ReturnType<typeof useProviderForm>;
  readonly mode: ProviderFormMode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

export const ProviderAliasFields: FC<Props> = ({ form, mode, open, onOpenChange }) => (
  <form.Subscribe selector={(state) => state.values.models ?? []}>
    {(models) => (
      <form.Field name="alias">
        {(field) => {
          const alias = field.state.value ?? {};
          const issues = aliasEditorIssues(alias, models);
          const summary = aliasSummary(alias);
          const update = (next: ProviderAlias) =>
            field.handleChange(serializeAlias(next, mode === ProviderFormMode.Create ? "create" : "edit"));

          return (
            <div data-testid="provider-form-field-alias">
              <Field data-invalid={issues.length > 0}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <FieldLabel>{m["dashboard.providers.form.label_aliases"]()}</FieldLabel>
                    <FieldDescription>{aliasSummaryMessage(summary)}</FieldDescription>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(true)}>
                    {m["dashboard.providers.actions.edit_aliases"]()}
                  </Button>
                </div>
                {issues.length > 0 && (
                  <FieldError>
                    {m["dashboard.providers.form.aliases_summary_errors"]({ errors: issues.length })}
                  </FieldError>
                )}
              </Field>
              <ProviderAliasDrawer
                alias={alias}
                models={models}
                issues={issues}
                open={open}
                onOpenChange={onOpenChange}
                onAliasChange={update}
              />
            </div>
          );
        }}
      </form.Field>
    )}
  </form.Subscribe>
);
