import { m } from '@aio-proxy/i18n';
import type { AliasConfig } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Trash2Icon } from 'lucide-react';
import { type FC, useState } from 'react';

import type { AliasEditorIssue, AliasEditResult, ProviderAlias } from '../../lib/alias-editor';
import { variantRows } from '../../lib/alias-editor';
import { ProviderAliasConfigFields } from './provider-alias-config-fields';
import { ProviderAliasDeleteDialog } from './provider-alias-delete-dialog';
import { ProviderAliasVariants } from './provider-alias-variants';

interface ProviderAliasCardProps {
  readonly alias: ProviderAlias;
  readonly aliasName: string;
  readonly config: AliasConfig;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onRename: (name: string) => AliasEditResult;
  readonly onRemove: () => void;
}

export const ProviderAliasCard: FC<ProviderAliasCardProps> = ({
  alias,
  aliasName,
  config,
  models,
  issues,
  onAliasChange,
  onRename,
  onRemove,
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
            aria-label={m['dashboard.providers.form.remove_alias']()}
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
          onAliasChange={onAliasChange}
        />
      </CardContent>
      <ProviderAliasDeleteDialog
        alias={aliasName}
        variants={variantRows(config).length}
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
