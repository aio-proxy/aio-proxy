import { m } from "@aio-proxy/i18n";
import type { DashboardOAuthCapability } from "@aio-proxy/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { OAuthAccountFields } from "../components/oauth-account-fields";
import { OAuthAuthorizationPanel } from "../components/oauth-authorization-panel";
import { OAuthCapabilityCombobox } from "../components/oauth-capability-combobox";
import { useOAuthProviderForm } from "../hooks/use-oauth-provider-form";
import { oauthAccountSubmission } from "../services/oauth-account-submission";
import {
  cancelOAuthSession,
  oauthCapabilitiesQueryOptions,
  oauthSessionQueryOptions,
  startOAuthSession,
  submitOAuthCallback,
} from "../services/oauth-service";

interface OAuthProviderCreatePageProps {
  readonly sessionId: string | undefined;
  readonly onSessionIdChange: (sessionId: string | undefined) => void;
}

const capabilityKey = (capability: DashboardOAuthCapability) => `${capability.plugin}\0${capability.capability}`;

export const OAuthProviderCreatePage: React.FC<OAuthProviderCreatePageProps> = ({ sessionId, onSessionIdChange }) => {
  const navigate = useNavigate();
  const popup = useRef<Window | null>(null);
  const capabilitiesQuery = useQuery(oauthCapabilitiesQueryOptions());
  const sessionQuery = useQuery(oauthSessionQueryOptions(sessionId ?? ""));
  const startMutation = useMutation({
    mutationFn: startOAuthSession,
    onSuccess: ({ session }) => onSessionIdChange(session.id),
  });
  const callbackMutation = useMutation({ mutationFn: submitOAuthCallback });
  const cancelMutation = useMutation({
    mutationFn: cancelOAuthSession,
    onSuccess: () => onSessionIdChange(undefined),
  });
  const capabilities = capabilitiesQuery.data?.capabilities ?? [];
  const form = useOAuthProviderForm((value) => {
    const capability = capabilities.find((candidate) => capabilityKey(candidate) === value.capabilityKey);
    if (capability === undefined) return;
    const account = oauthAccountSubmission(capability.form, value);
    popup.current = window.open("", "_blank");
    startMutation.mutate({
      capability: { plugin: capability.plugin, capability: capability.capability },
      ...account,
    });
  });
  const session = sessionQuery.data?.session;

  useEffect(() => {
    if (session?.status === "loopback" && popup.current !== null) {
      popup.current.location.href = session.authorizationUrl;
      popup.current = null;
    }
    if (session?.status === "succeeded") {
      void navigate({
        to: "/providers",
        search: {
          focus: session.providerId,
          ...(session.warning === undefined ? {} : { warning: session.warning }),
        },
      });
    }
  }, [navigate, session]);

  return (
    <PageContainer title={m["dashboard.providers.new_title"]()} backTo="/providers">
      <div className="max-w-lg space-y-6 p-4">
        {sessionId === undefined ? (
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Subscribe selector={(state) => state.values.capabilityKey}>
              {(selectedKey) => {
                const selected = capabilities.find((candidate) => capabilityKey(candidate) === selectedKey);
                return (
                  <>
                    <form.Field name="capabilityKey">
                      {(field) => (
                        <OAuthCapabilityCombobox
                          capabilities={capabilities}
                          value={selected ?? null}
                          onValueChange={(value) => {
                            field.handleChange(value === null ? "" : capabilityKey(value));
                            form.setFieldValue("publicValues", value?.defaults ?? {});
                            form.setFieldValue("secrets", {});
                            form.setFieldValue("clearSecrets", []);
                            form.setFieldValue("jsonValues", {});
                          }}
                        />
                      )}
                    </form.Field>
                    {selected === undefined ? null : <OAuthAccountFields fields={selected.form} form={form} />}
                    <Button type="submit" disabled={selected === undefined || startMutation.isPending}>
                      {m["dashboard.providers.oauth.continue"]()}
                    </Button>
                  </>
                );
              }}
            </form.Subscribe>
          </form>
        ) : session === undefined ? null : (
          <OAuthAuthorizationPanel
            session={session}
            isPending={callbackMutation.isPending || cancelMutation.isPending}
            onSubmitCallback={(callbackUrl) =>
              callbackMutation.mutate({ id: session.id, callbackUrl }, { onSuccess: () => sessionQuery.refetch() })
            }
            onCancel={() => cancelMutation.mutate(session.id)}
          />
        )}
      </div>
    </PageContainer>
  );
};
