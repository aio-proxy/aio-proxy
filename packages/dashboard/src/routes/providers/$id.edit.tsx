import { m } from "@aio-proxy/i18n";
import type { DashboardProviderSummary } from "@aio-proxy/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DeleteProviderDialog } from "@/modules/providers/components/delete-provider-dialog";
import { providerEditViewQueryOptions } from "@/modules/providers/services/providers-service";
import { ProviderFormPage } from "@/modules/providers/templates/provider-form-page";

export const Route = createFileRoute("/providers/$id/edit")({
  component: EditProviderPage,
});

function EditProviderPage() {
  const { id } = Route.useParams();
  const { data, isLoading } = useQuery(providerEditViewQueryOptions(id));
  const [showDelete, setShowDelete] = useState(false);

  if (isLoading) return <div>Loading...</div>;
  if (!data?.provider) return <div data-testid="not-found">Not Found</div>;

  const provider = data.provider;

  if (provider.kind === "oauth") {
    return (
      <div data-testid="provider-oauth-readonly" className="p-4 space-y-4">
        <p>{m["dashboard.providers.oauth_managed_cli"]()}</p>
        <Button variant="destructive" onClick={() => setShowDelete(true)}>
          {m["dashboard.providers.actions.delete"]()}
        </Button>
        {showDelete && (
          <DeleteProviderDialog
            provider={provider as unknown as DashboardProviderSummary}
            open={showDelete}
            onOpenChange={setShowDelete}
          />
        )}
      </div>
    );
  }

  return <ProviderFormPage mode="edit" kind={provider.kind as "api" | "ai-sdk"} initial={provider} providerId={id} />;
}
