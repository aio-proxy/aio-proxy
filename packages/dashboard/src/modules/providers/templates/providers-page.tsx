import type React from "react";

import { m } from "@aio-proxy/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

import { ProvidersTable } from "../components/providers-table";
import { providersQueryOptions } from "../services/providers-service";

interface ProvidersPageProps {
  readonly focusProviderId?: string;
  readonly warning?: "catalog_unavailable";
}

export const ProvidersPage: React.FC<ProvidersPageProps> = ({ focusProviderId, warning }) => {
  const providersQuery = useQuery(providersQueryOptions());
  const providers = providersQuery.data?.providers ?? [];

  return (
    <PageContainer
      title={m["dashboard.providers.list_title"]()}
      extra={
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button data-testid="new-provider-button" />}>
            {m["dashboard.providers.new_provider"]()}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem render={<Link preload="intent" to="/providers/new/$kind" params={{ kind: "oauth" }} />}>
              {m["dashboard.providers.kind_label.oauth"]()}
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link preload="intent" to="/providers/new/$kind" params={{ kind: "api" }} />}>
              {m["dashboard.providers.kind_label.api"]()}
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link preload="intent" to="/providers/new/$kind" params={{ kind: "ai-sdk" }} />}>
              {m["dashboard.providers.kind_label.ai-sdk"]()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <Card>
        <CardContent>
          {warning === "catalog_unavailable" ? (
            <p role="status" className="mb-3 rounded-lg border bg-muted p-3 text-sm">
              {m["dashboard.providers.oauth.catalog_warning"]()}
            </p>
          ) : null}
          {providersQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ProvidersTable providers={providers} focusProviderId={focusProviderId} />
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
};
