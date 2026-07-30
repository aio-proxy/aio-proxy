import { m } from '@aio-proxy/i18n';
import type { ProviderKind } from '@aio-proxy/types';
import { useNavigate } from '@tanstack/react-router';
import { type FC, useRef, useState } from 'react';

import { PageContainer } from '@/components/page-container';
import { Button } from '@/components/ui/button';

import { aliasEditorIssues, aliasIssueControlId } from '../alias-editor';
import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../components/delete-provider-dialog';
import { ProviderFormFieldsAiSdk } from '../components/provider-form-fields-ai-sdk';
import { ProviderFormFieldsApi } from '../components/provider-form-fields-api';
import { ProviderFormMode } from '../constants';
import { type ProviderFormInitial, useProviderForm } from '../hooks/use-provider-form';
import { useProviderCreate, useProviderUpdate } from '../hooks/use-provider-mutations';

interface ProviderFormPageProps {
  mode: ProviderFormMode;
  kind: ProviderKind;
  initial?: ProviderFormInitial;
  providerId?: string;
}

export const ProviderFormPage: FC<ProviderFormPageProps> = ({ mode, kind, initial, providerId }) => {
  const navigate = useNavigate();
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [optionsValid, setOptionsValid] = useState(kind === 'api');
  const [transformsValid, setTransformsValid] = useState(true);
  const { mutate: createProvider, isPending: isCreating } = useProviderCreate();
  const { mutate: updateProvider, isPending: isUpdating } = useProviderUpdate();
  const isPending = isCreating || isUpdating;

  const form = useProviderForm({
    mode,
    kind,
    initial,
    onSubmit: async (value) => {
      if (mode === ProviderFormMode.Create) {
        createProvider(value, {
          onSuccess: () => {
            void navigate({ to: '/providers' });
          },
        });
      } else if (providerId) {
        updateProvider(
          { id: providerId, body: value },
          {
            onSuccess: () => {
              void navigate({ to: '/providers' });
            },
          },
        );
      }
    },
  });

  const title =
    mode === ProviderFormMode.Create ? m['dashboard.providers.new_title']() : m['dashboard.providers.edit_title']();
  const subtitle =
    mode === ProviderFormMode.Edit && providerId !== undefined
      ? `${providerId} · ${kind === 'api' ? m['dashboard.providers.kind_label.api']() : m['dashboard.providers.kind_label.ai-sdk']()}`
      : undefined;

  const submit = () => {
    if (!optionsValid || !transformsValid) {
      return;
    }
    const issues = aliasEditorIssues(form.getFieldValue('alias') ?? {}, form.getFieldValue('models'));
    const issue = issues[0];
    if (issue !== undefined) {
      setAliasOpen(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => document.getElementById(aliasIssueControlId(issue))?.focus());
      });
      return;
    }
    void form.handleSubmit();
  };

  return (
    <PageContainer title={title} {...(subtitle === undefined ? {} : { subtitle })} backTo="/providers">
      <div className="mx-auto max-w-4xl space-y-6 px-1 pb-4 sm:p-4">
        <form
          className="space-y-8"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }}
        >
          {kind === 'api' ? (
            <ProviderFormFieldsApi
              form={form}
              mode={mode}
              providerId={providerId}
              aliasOpen={aliasOpen}
              onAliasOpenChange={setAliasOpen}
              onTransformsValidityChange={setTransformsValid}
            />
          ) : (
            <ProviderFormFieldsAiSdk
              form={form}
              mode={mode}
              providerId={providerId}
              aliasOpen={aliasOpen}
              onAliasOpenChange={setAliasOpen}
              onOptionsValidityChange={setOptionsValid}
              onTransformsValidityChange={setTransformsValid}
            />
          )}
          <div className="flex items-center justify-between gap-3 border-t pt-4" data-testid="provider-form-actions">
            <div className="flex gap-3">
              <Button
                type="submit"
                disabled={!optionsValid || !transformsValid || isPending}
                data-testid="provider-save"
              >
                {m['dashboard.providers.actions.save']()}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="provider-cancel"
                onClick={() => void navigate({ to: '/providers' })}
              >
                {m['dashboard.providers.actions.cancel']()}
              </Button>
            </div>
            {mode === ProviderFormMode.Edit && providerId !== undefined ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => deleteDialogRef.current?.open({ id: providerId })}
              >
                {m['dashboard.providers.actions.delete']()}
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      <DeleteProviderDialog ref={deleteDialogRef} onDeleted={() => void navigate({ to: '/providers' })} />
    </PageContainer>
  );
};
