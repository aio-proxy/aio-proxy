import { m } from "@aio-proxy/i18n";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "@/components/page-container";
import { providerEditViewQueryOptions } from "@/modules/providers/services/providers-service";

export const Route = createFileRoute("/providers/$id/aliases")({
  component: AliasesPage,
});

function AliasesPage() {
  const { id } = Route.useParams();
  const { data, isLoading } = useQuery(providerEditViewQueryOptions(id));

  return (
    <PageContainer title={m["dashboard.providers.aliases_title"]()} backTo="/providers">
      {isLoading ? (
        <div>Loading...</div>
      ) : (
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">{m["dashboard.providers.aliases_readonly_note"]()}</p>
          <pre className="rounded border bg-muted p-3 text-sm overflow-auto">
            {JSON.stringify(data?.provider?.alias ?? {}, null, 2)}
          </pre>
        </div>
      )}
    </PageContainer>
  );
}
