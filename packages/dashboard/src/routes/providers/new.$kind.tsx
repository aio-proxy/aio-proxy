import { createFileRoute, notFound } from "@tanstack/react-router";

import { ProviderFormMode } from "@/modules/providers/constants";
import { ProviderFormPage } from "@/modules/providers/templates/provider-form-page";

export const Route = createFileRoute("/providers/new/$kind")({
  component: NewProviderPage,
});

function NewProviderPage() {
  const { kind } = Route.useParams();
  if (kind !== "api" && kind !== "ai-sdk") {
    throw notFound();
  }
  return <ProviderFormPage mode={ProviderFormMode.Create} kind={kind} initial={{ enabled: true, weight: 0 }} />;
}
