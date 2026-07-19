import type { AliasConfig } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";
import { Trash2Icon } from "lucide-react";
import { type FC, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { AliasEditorIssue, AliasEditResult, ProviderAlias } from "../../alias-editor";

import { ProviderAliasConfigFields } from "./provider-alias-config-fields";
import { ProviderAliasDeleteDialog } from "./provider-alias-delete-dialog";
import { ProviderAliasVariants } from "./provider-alias-variants";

type Props = {
  readonly alias: ProviderAlias;
  readonly aliasName: string;
  readonly config: AliasConfig;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly variantDraftIds: readonly string[];
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onRename: (name: string) => AliasEditResult;
  readonly onRemove: () => void;
  readonly onAddVariantDraft: () => void;
  readonly onDiscardVariantDraft: (id: string) => void;
  readonly onDraftDirtyChange: (id: string, dirty: boolean) => void;
};

export const ProviderAliasCard: FC<Props> = ({
  alias,
  aliasName,
  config,
  models,
  issues,
  variantDraftIds,
  onAliasChange,
  onRename,
  onRemove,
  onAddVariantDraft,
  onDiscardVariantDraft,
  onDraftDirtyChange,
}) => {
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <Card size="sm" data-testid="provider-alias-card">
      <CardHeader>
        <CardTitle>{aliasName}</CardTitle>
        <CardDescription>{config.model}</CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={m["dashboard.providers.form.remove_alias"]()}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2Icon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ProviderAliasConfigFields
          alias={alias}
          aliasName={aliasName}
          config={config}
          models={models}
          issue={issues.find((issue) => issue.variant === undefined)}
          onAliasChange={onAliasChange}
          onRename={onRename}
        />
        <ProviderAliasVariants
          alias={alias}
          aliasName={aliasName}
          config={config}
          models={models}
          issues={issues.filter((issue) => issue.variant !== undefined)}
          draftIds={variantDraftIds}
          onAliasChange={onAliasChange}
          onAddDraft={onAddVariantDraft}
          onDiscardDraft={onDiscardVariantDraft}
          onDraftDirtyChange={onDraftDirtyChange}
        />
      </CardContent>
      <ProviderAliasDeleteDialog
        alias={aliasName}
        variants={Object.keys(config.variants ?? {}).length}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => {
          onRemove();
          setDeleteOpen(false);
        }}
      />
    </Card>
  );
};
