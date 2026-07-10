import { m } from "@aio-proxy/i18n";
import type { AiSdkProviderMutationBody, ApiProviderMutationBody, ProviderKind } from "@aio-proxy/types";
import { useNavigate } from "@tanstack/react-router";
import type React from "react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { ProviderFormFieldsAiSdk } from "../components/provider-form-fields-ai-sdk";
import { ProviderFormFieldsApi } from "../components/provider-form-fields-api";
import { ProviderFormMode } from "../constants";
import { useProviderForm } from "../hooks/use-provider-form";
import { useProviderCreate, useProviderUpdate } from "../hooks/use-provider-mutations";

type Props = {
  mode: ProviderFormMode;
  kind: ProviderKind;
  initial?: Partial<ApiProviderMutationBody> | Partial<AiSdkProviderMutationBody>;
  providerId?: string;
};

export const ProviderFormPage: React.FC<Props> = ({ mode, kind, initial, providerId }) => {
  const navigate = useNavigate();
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
            void navigate({ to: "/providers" });
          },
        });
      } else if (providerId) {
        updateProvider(
          { id: providerId, body: value },
          {
            onSuccess: () => {
              void navigate({ to: "/providers" });
            },
          },
        );
      }
    },
  });

  const title =
    mode === ProviderFormMode.Create ? m["dashboard.providers.new_title"]() : m["dashboard.providers.edit_title"]();

  return (
    <PageContainer title={title} backTo="/providers">
      <div className="max-w-lg space-y-6 p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void form.handleSubmit();
          }}
        >
          {kind === "api" ? (
            <ProviderFormFieldsApi form={form} mode={mode} providerId={providerId} />
          ) : (
            <ProviderFormFieldsAiSdk form={form} mode={mode} providerId={providerId} />
          )}
          <div className="mt-6 flex gap-3">
            <Button type="submit" disabled={isPending} data-testid="provider-save">
              {m["dashboard.providers.actions.save"]()}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="provider-cancel"
              onClick={() => void navigate({ to: "/providers" })}
            >
              {m["dashboard.providers.actions.cancel"]()}
            </Button>
          </div>
        </form>
      </div>
    </PageContainer>
  );
};
