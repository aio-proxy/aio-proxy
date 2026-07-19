import { createFileRoute, notFound, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type React from "react";
import { ProviderFormMode } from "@/modules/providers/constants";
import { OAuthProviderCreatePage } from "@/modules/providers/templates/oauth-provider-create-page";
import { ProviderFormPage } from "@/modules/providers/templates/provider-form-page";

const NewProviderPage: React.FC = () => {
  const { kind } = useParams({ from: "/providers/new/$kind" });
  const { session } = useSearch({ from: "/providers/new/$kind" });
  const navigate = useNavigate({ from: "/providers/new/$kind" });
  if (kind === "oauth") {
    return (
      <OAuthProviderCreatePage
        sessionId={session}
        onSessionIdChange={(next) =>
          void navigate({ search: next === undefined ? {} : { session: next }, replace: true })
        }
      />
    );
  }
  if (kind !== "api" && kind !== "ai-sdk") {
    throw notFound();
  }
  return <ProviderFormPage mode={ProviderFormMode.Create} kind={kind} initial={{ enabled: true, weight: 0 }} />;
};

export const Route = createFileRoute("/providers/new/$kind")({
  validateSearch: (raw) => ({ session: typeof raw.session === "string" ? raw.session : undefined }),
  component: NewProviderPage,
});
