import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { parseLogsSearch } from "@/modules/logs/logs-search";
import { LogsPage } from "@/modules/logs/templates/logs-page";

const LogsRoute: React.FC = () => {
  const search = useSearch({ from: "/logs" });
  const navigate = useNavigate({ from: "/logs" });
  const canonicalized = useRef(false);

  useEffect(() => {
    if (canonicalized.current) return;
    canonicalized.current = true;
    void navigate({ search, replace: true });
  }, [navigate, search]);

  return <LogsPage search={search} onSearchChange={(next) => void navigate({ search: next })} />;
};

export const Route = createFileRoute("/logs")({
  validateSearch: (raw) => parseLogsSearch(raw),
  component: LogsRoute,
});
