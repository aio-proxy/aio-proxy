import type { DashboardOAuthProviderEdit, DashboardOAuthSession, OAuthProvider } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";

import { aliasEditorIssues, aliasIssueControlId } from "../alias-editor";
import { DeleteProviderDialog, type DeleteProviderDialogRef } from "../components/delete-provider-dialog";
import { OAuthAuthorizationPanel } from "../components/oauth-authorization-panel";
import { OAuthProviderEditFields } from "../components/oauth-provider-edit-fields";
import { useOAuthProviderEditForm } from "../hooks/use-oauth-provider-edit-form";
import { useOAuthProviderForm } from "../hooks/use-oauth-provider-form";
import { useProviderUpdate } from "../hooks/use-provider-mutations";
import { oauthAccountSubmission } from "../services/oauth-account-submission";
import { oauthProviderEditAction } from "../services/oauth-provider-edit";
import {
  cancelOAuthSession,
  oauthSessionQueryOptions,
  startOAuthSession,
  submitOAuthCallback,
} from "../services/oauth-service";

interface OAuthProviderEditPageProps {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly sessionId: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

export const OAuthProviderEditPage: React.FC<OAuthProviderEditPageProps> = ({
  provider,
  oauth,
  sessionId,
  onSessionIdChange,
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const popup = useRef<Window | null>(null);
  const forceReauthorization = useRef(false);
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const [aliasOpen, setAliasOpen] = useState(false);
  const accountForm = useOAuthProviderForm(() => undefined, {
    capabilityKey: `${provider.plugin}\0${provider.capability}`,
    publicValues: oauth.publicValues,
    secrets: {},
    clearSecrets: [],
    jsonValues: {},
  });
  const { mutate: updateProvider, isPending: isUpdating } = useProviderUpdate();
  const startMutation = useMutation({
    mutationFn: startOAuthSession,
    onSuccess: ({ session }) => onSessionIdChange(session.id),
  });
  const callbackMutation = useMutation({ mutationFn: submitOAuthCallback });
  const cancelMutation = useMutation({
    mutationFn: cancelOAuthSession,
    onSuccess: () => onSessionIdChange(undefined),
  });
  const sessionQuery = useQuery(oauthSessionQueryOptions(sessionId ?? ""));
  const form = useOAuthProviderEditForm(
    {
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      weight: provider.weight,
      alias: provider.alias,
      models: oauth.models,
    },
    (value) => {
      const account = oauthAccountSubmission(oauth.form, {
        publicValues: accountForm.getFieldValue("publicValues"),
        secrets: accountForm.getFieldValue("secrets"),
        clearSecrets: accountForm.getFieldValue("clearSecrets"),
      });
      const action = oauthProviderEditAction(
        {
          ...value,
          ...account,
        },
        oauth.publicValues,
        forceReauthorization.current,
      );
      forceReauthorization.current = false;
      if (action.kind === "update") {
        updateProvider(
          { id: provider.id, body: action.body },
          { onSuccess: () => void navigate({ to: "/providers", search: { focus: provider.id } }) },
        );
        return;
      }
      popup.current = window.open("", "_blank");
      startMutation.mutate(action.input);
    },
  );
  const session: DashboardOAuthSession | undefined =
    sessionQuery.data?.session ??
    (sessionId !== undefined && sessionQuery.isError
      ? { id: sessionId, status: "failed", code: "OAUTH_SESSION_UNAVAILABLE" }
      : undefined);

  useEffect(() => {
    if (session?.status === "loopback" && popup.current !== null) {
      popup.current.location.href = session.authorizationUrl;
      popup.current = null;
    }
    if (session?.status === "succeeded") {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void navigate({
        to: "/providers",
        search: {
          focus: session.providerId,
          ...(session.warning === undefined ? {} : { warning: session.warning }),
        },
      });
    }
  }, [navigate, queryClient, session]);

  const submit = (reauthorize: boolean) => {
    const issue = aliasEditorIssues(form.getFieldValue("alias") ?? {}, oauth.models)[0];
    if (issue !== undefined) {
      setAliasOpen(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => document.getElementById(aliasIssueControlId(issue))?.focus());
      });
      return;
    }
    forceReauthorization.current = reauthorize;
    void form.handleSubmit();
  };

  return (
    <PageContainer
      title={m["dashboard.providers.edit_title"]()}
      subtitle={`${provider.id} · ${m["dashboard.providers.kind_label.oauth"]()}`}
      backTo="/providers"
    >
      <div className="mx-auto max-w-4xl space-y-6 px-1 pb-4 sm:p-4">
        {sessionId === undefined ? (
          <form
            className="space-y-8"
            onSubmit={(event) => {
              event.preventDefault();
              submit(false);
            }}
          >
            <OAuthProviderEditFields
              provider={provider}
              oauth={oauth}
              form={form}
              accountForm={accountForm}
              aliasOpen={aliasOpen}
              onAliasOpenChange={setAliasOpen}
              onReauthorize={() => submit(true)}
              isReauthorizing={isUpdating || startMutation.isPending}
            />
            <div className="flex items-center justify-between gap-3 border-t pt-4" data-testid="provider-form-actions">
              <div className="flex gap-3">
                <Button type="submit" disabled={isUpdating || startMutation.isPending}>
                  {m["dashboard.providers.actions.save"]()}
                </Button>
                <Button type="button" variant="outline" onClick={() => void navigate({ to: "/providers" })}>
                  {m["dashboard.providers.actions.cancel"]()}
                </Button>
              </div>
              <Button type="button" variant="destructive" onClick={() => deleteDialogRef.current?.open(provider)}>
                {m["dashboard.providers.actions.delete"]()}
              </Button>
            </div>
          </form>
        ) : session === undefined ? null : (
          <OAuthAuthorizationPanel
            session={session}
            isPending={callbackMutation.isPending || cancelMutation.isPending}
            onSubmitCallback={(callbackUrl) =>
              callbackMutation.mutate({ id: session.id, callbackUrl }, { onSuccess: () => sessionQuery.refetch() })
            }
            onCancel={() => {
              if (session.status === "failed" || session.status === "cancelled") {
                onSessionIdChange(undefined);
                return;
              }
              cancelMutation.mutate(session.id);
            }}
          />
        )}
      </div>
      <DeleteProviderDialog ref={deleteDialogRef} onDeleted={() => void navigate({ to: "/providers" })} />
    </PageContainer>
  );
};
