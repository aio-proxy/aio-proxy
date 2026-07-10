import { m } from "@aio-proxy/i18n";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DeleteProviderDialog,
  type DeleteProviderDialogRef,
} from "@/modules/providers/components/delete-provider-dialog";
import { ProviderFormMode } from "@/modules/providers/constants";
import { providerEditViewQueryOptions } from "@/modules/providers/services/providers-service";
import { ProviderFormPage } from "@/modules/providers/templates/provider-form-page";

export const Route = createFileRoute("/providers/$id/edit")({
  component: EditProviderPage,
});

function EditProviderPage() {
  const { id } = Route.useParams();
  const { data, isLoading } = useQuery(providerEditViewQueryOptions(id));
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);

  if (isLoading) return <div>Loading...</div>;

  if (!data || "error" in data || !data.provider) return <div data-testid="not-found">Not Found</div>;

  const provider = data.provider;

  if (provider.kind === "oauth") {
    return (
      <div data-testid="provider-oauth-readonly" className="space-y-4 p-4">
        <p>{m["dashboard.providers.oauth_managed_cli"]()}</p>
        <Button variant="destructive" onClick={() => deleteDialogRef.current?.open(provider)}>
          {m["dashboard.providers.actions.delete"]()}
        </Button>
        <DeleteProviderDialog ref={deleteDialogRef} />
      </div>
    );
  }

  return <ProviderFormPage mode={ProviderFormMode.Edit} kind={provider.kind} initial={provider} providerId={id} />;
}
