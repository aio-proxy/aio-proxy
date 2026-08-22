import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperPanel,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@aio-proxy/ui/components/reui/stepper';
import { useNavigate } from '@tanstack/react-router';
import { type FC, useRef, useState } from 'react';

import { PageContainer } from '@/components/page-container';

import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../components/delete-provider-dialog';
import { ProviderFormFieldsAiSdk } from '../components/provider-form-fields-ai-sdk';
import { ProviderFormFieldsApi } from '../components/provider-form-fields-api';
import { ProviderValidateStep } from '../components/provider-validate-step';
import {
  type ProviderEditorKind,
  type ProviderFormInitial,
  providerFormStepIsValid,
  useProviderForm,
} from '../hooks/use-provider-form';
import { useProviderCreate, useProviderUpdate } from '../hooks/use-provider-mutations';
import { aliasEditorIssues, aliasIssueControlId } from '../lib/alias-editor';
import { ProviderFormMode, type ProviderFormStep, PROVIDER_KIND_LABEL } from '../lib/constants';

interface ProviderFormPageProps {
  mode: ProviderFormMode;
  kind: ProviderEditorKind;
  initial?: ProviderFormInitial;
  providerId?: string;
}

const isProviderFormStep = (value: number): value is ProviderFormStep => value >= 0 && value <= 3;

export const ProviderFormPage: FC<ProviderFormPageProps> = ({ mode, kind, initial, providerId }) => {
  const navigate = useNavigate();
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const [activeStep, setActiveStep] = useState<ProviderFormStep>(0);
  const [stepInvalid, setStepInvalid] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [optionsValid, setOptionsValid] = useState(kind === ProviderKind.Api);
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
        createProvider(value, { onSuccess: () => void navigate({ to: '/providers' }) });
      } else if (providerId) {
        updateProvider({ id: providerId, body: value }, { onSuccess: () => void navigate({ to: '/providers' }) });
      }
    },
  });

  const title =
    mode === ProviderFormMode.Create ? m['dashboard.providers.new_title']() : m['dashboard.providers.edit_title']();
  const subtitle =
    mode === ProviderFormMode.Edit && providerId !== undefined
      ? `${providerId} · ${kind === ProviderKind.Api ? PROVIDER_KIND_LABEL.api : PROVIDER_KIND_LABEL['ai-sdk']}`
      : undefined;
  const steps = [
    m['dashboard.providers.editor.step_connection'](),
    m['dashboard.providers.editor.step_models'](),
    m['dashboard.providers.editor.step_routing'](),
    m['dashboard.providers.editor.step_validate'](),
  ] as const;

  const currentStepIsValid = () =>
    providerFormStepIsValid(kind, activeStep, form.state.values) &&
    (activeStep !== 0 || optionsValid) &&
    (activeStep !== 2 || transformsValid);

  const changeStep = (nextStep: number) => {
    if (!isProviderFormStep(nextStep)) return;
    if (nextStep > activeStep && !currentStepIsValid()) {
      setStepInvalid(true);
      return;
    }
    setStepInvalid(false);
    setActiveStep(nextStep);
  };

  const submit = () => {
    if (!optionsValid || !transformsValid) return;
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
    <PageContainer
      title={title}
      {...(subtitle === undefined ? {} : { subtitle })}
      breadcrumbs={[
        { label: m['dashboard.menus.configuration']() },
        { label: m['dashboard.providers.list_title'](), to: '/providers' },
        { label: title },
      ]}
    >
      <div id="provider-editor" data-testid="provider-editor" className="mx-auto max-w-2xl px-1 pb-4 sm:p-4">
        <form
          className="space-y-8"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (activeStep < 3) changeStep(activeStep + 1);
            else submit();
          }}
        >
          <Stepper value={activeStep} onValueChange={changeStep} orientation="horizontal" aria-label={title}>
            <StepperNav aria-label={title}>
              {steps.map((label, step) => (
                <StepperItem key={label} step={step}>
                  <StepperTrigger aria-label={label}>
                    <StepperIndicator>{step + 1}</StepperIndicator>
                    <StepperTitle>{label}</StepperTitle>
                  </StepperTrigger>
                  {step < steps.length - 1 ? <StepperSeparator /> : null}
                </StepperItem>
              ))}
            </StepperNav>
            <StepperPanel className="mt-8">
              {stepInvalid ? (
                <p role="alert" className="mb-5 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
                  {m['dashboard.providers.editor.step_invalid']()}
                </p>
              ) : null}
              <div id={`stepper-panel-${activeStep}`} role="tabpanel" aria-labelledby={`stepper-tab-${activeStep}`}>
                {kind === ProviderKind.Api ? (
                  <ProviderFormFieldsApi
                    form={form}
                    mode={mode}
                    providerId={providerId}
                    activeStep={activeStep}
                    aliasOpen={aliasOpen}
                    onAliasOpenChange={setAliasOpen}
                    onTransformsValidityChange={setTransformsValid}
                  />
                ) : (
                  <ProviderFormFieldsAiSdk
                    form={form}
                    mode={mode}
                    providerId={providerId}
                    activeStep={activeStep}
                    aliasOpen={aliasOpen}
                    onAliasOpenChange={setAliasOpen}
                    onOptionsValidityChange={setOptionsValid}
                    onTransformsValidityChange={setTransformsValid}
                  />
                )}
                {activeStep === 3 ? (
                  <ProviderValidateStep
                    form={form}
                    {...(providerId === undefined ? {} : { persistedProviderId: providerId })}
                  />
                ) : null}
              </div>
            </StepperPanel>
          </Stepper>

          <div className="flex items-center justify-between gap-3 border-t pt-4" data-testid="provider-form-actions">
            <div className="flex gap-3">
              {activeStep > 0 ? (
                <Button type="button" variant="outline" onClick={() => changeStep(activeStep - 1)}>
                  {m['dashboard.providers.editor.previous']()}
                </Button>
              ) : null}
              {activeStep < 3 ? (
                <Button type="button" onClick={() => changeStep(activeStep + 1)}>
                  {m['dashboard.providers.editor.next']()}
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={!optionsValid || !transformsValid || isPending}
                  data-testid="provider-save"
                >
                  {m['dashboard.providers.actions.save']()}
                </Button>
              )}
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
