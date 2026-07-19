import { createFileRoute, useSearch } from "@tanstack/react-router";
import { ProvidersPage } from "@/modules/providers/templates/providers-page";

const ProvidersRoute: React.FC = () => {
  const { focus, warning } = useSearch({ from: "/providers/" });
  return <ProvidersPage focusProviderId={focus} warning={warning} />;
};

export const Route = createFileRoute("/providers/")({
  validateSearch: (raw) => ({
    focus: typeof raw.focus === "string" ? raw.focus : undefined,
    warning: raw.warning === "catalog_unavailable" ? raw.warning : undefined,
  }),
  component: ProvidersRoute,
});
