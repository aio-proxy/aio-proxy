import { m } from "@aio-proxy/i18n";
import type { AliasConfig, AliasTarget } from "@aio-proxy/types";
import { omit } from "es-toolkit/object";
import { ChevronDownIcon, ChevronUpIcon, PlusIcon } from "lucide-react";
import { type FC, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import {
  type AliasEditorIssue,
  type AliasEditResult,
  commitVariantDraft,
  type ProviderAlias,
  renameVariant,
} from "../../alias-editor";
import { ProviderVariantDraft } from "../provider-variant-draft";
import { ProviderVariantRow } from "../provider-variant-row";

type Props = {
  readonly alias: ProviderAlias;
  readonly aliasName: string;
  readonly config: AliasConfig;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly draftIds: readonly string[];
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onAddDraft: () => void;
  readonly onDiscardDraft: (id: string) => void;
  readonly onDraftDirtyChange: (id: string, dirty: boolean) => void;
};

export const ProviderAliasVariants: FC<Props> = ({
  alias,
  aliasName,
  config,
  models,
  issues,
  draftIds,
  onAliasChange,
  onAddDraft,
  onDiscardDraft,
  onDraftDirtyChange,
}) => {
  const variants = config.variants ?? {};
  const [open, setOpen] = useState(issues.length > 0 || draftIds.length > 0);
  const expanded = open || issues.length > 0 || draftIds.length > 0;
  const canCollapse = issues.length === 0 && draftIds.length === 0;

  return (
    <>
      <Separator />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={expanded && !canCollapse}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? m["dashboard.providers.form.collapse_variants"]({ alias: aliasName })
                : m["dashboard.providers.form.expand_variants"]({ alias: aliasName })
            }
            onClick={() => setOpen((current) => !current)}
          >
            {expanded ? <ChevronUpIcon data-icon="inline-start" /> : <ChevronDownIcon data-icon="inline-start" />}
            {m["dashboard.providers.form.label_variants"]()}
          </Button>
          <Badge variant="secondary">{Object.keys(variants).length + draftIds.length}</Badge>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(true);
            onAddDraft();
          }}
        >
          <PlusIcon data-icon="inline-start" />
          {m["dashboard.providers.form.add_variant"]()}
        </Button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-3">
          <FieldDescription>{m["dashboard.providers.form.variants_helper"]()}</FieldDescription>
          {Object.entries(variants).map(([variantName, target]) => (
            <ProviderVariantRow
              key={variantName}
              alias={alias}
              aliasName={aliasName}
              variantName={variantName}
              target={target}
              models={models}
              issues={issues.filter((issue) => issue.variant === variantName)}
              onChange={(nextTarget: AliasTarget) =>
                onAliasChange({
                  ...alias,
                  [aliasName]: { ...config, variants: { ...variants, [variantName]: nextTarget } },
                })
              }
              onRename={(name): AliasEditResult => {
                const result = renameVariant(alias, { alias: aliasName, variant: variantName, name });
                if (result.ok) onAliasChange(result.alias);
                return result;
              }}
              onRemove={() => {
                const nextVariants = omit(variants, [variantName]);
                onAliasChange({
                  ...alias,
                  [aliasName]: {
                    ...config,
                    variants: Object.keys(nextVariants).length === 0 ? undefined : nextVariants,
                  },
                });
              }}
            />
          ))}
          {draftIds.map((id) => (
            <ProviderVariantDraft
              key={id}
              id={id}
              models={models}
              onDirtyChange={onDraftDirtyChange}
              onDiscard={() => onDiscardDraft(id)}
              onCommit={(draft) => {
                const result = commitVariantDraft(alias, aliasName, draft);
                if (result.ok) {
                  onAliasChange(result.alias);
                  onDiscardDraft(id);
                }
                return result;
              }}
            />
          ))}
        </div>
      )}
    </>
  );
};
