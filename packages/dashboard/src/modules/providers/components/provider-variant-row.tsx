import { m } from '@aio-proxy/i18n';
import type { AliasTarget } from '@aio-proxy/types';
import { useForm } from '@tanstack/react-form';
import { Trash2Icon } from 'lucide-react';
import { type FC, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import {
  type AliasDraft,
  type AliasEditorIssue,
  type AliasEditResult,
  aliasControlId,
  type ProviderAlias,
  preserveReferenceCount,
} from '../alias-editor';
import { aliasEditErrorMessage, aliasIssueMessage, type VisibleEditError } from '../alias-editor-copy';
import { ProviderVariantFields } from './provider-variant-fields';

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
  const nameInvalid =
    editError === 'name-required' || editError === 'name-duplicate' || (issue?.code.includes('name-') ?? false);
  const targetInvalid = editError === 'target-required' || issue?.code === 'target-missing';
  const preserveCount = preserveReferenceCount(alias, target.model) - (target.preserve ? 1 : 0);
  const nameId = aliasControlId(aliasName, variantName);
  const targetId = `${nameId}-target`;
  const preserveId = `${nameId}-preserve`;

  const commitName = (name: string) => {
    const result = onRename(name);
    if (result.ok) {
      setEditError(null);
    } else if (result.code !== 'alias-missing') {
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
            aria-label={m['dashboard.providers.form.remove_variant']()}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ProviderVariantFields
          form={form}
          target={target}
          models={models}
          nameId={nameId}
          targetId={targetId}
          preserveId={preserveId}
          nameInvalid={nameInvalid}
          targetInvalid={targetInvalid}
          preserveCount={preserveCount}
          errorMessage={errorMessage}
          setEditError={setEditError}
          onChange={onChange}
          commitName={commitName}
        />
      </CardContent>
    </Card>
  );
};
