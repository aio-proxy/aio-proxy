import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { parseLogsSearch } from "@/modules/logs/logs-search";
import { LogsPage } from "@/modules/logs/templates/logs-page";

export const Route = createFileRoute("/logs")({
  validateSearch: (raw) => parseLogsSearch(raw),
  component: LogsRoute,
});

function LogsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const canonicalized = useRef(false);

  useEffect(() => {
    if (canonicalized.current) return;
    canonicalized.current = true;
    void navigate({ search, replace: true });
  }, [navigate, search]);

  return <LogsPage search={search} onSearchChange={(next) => void navigate({ search: next })} />;
}
