import type React from "react";

import { m } from "@aio-proxy/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

import { PluginsTable } from "../components/plugins-table";
import { ProvidersTable } from "../components/providers-table";
import { pluginsQueryOptions } from "../services/plugins-service";
import { providersQueryOptions } from "../services/providers-service";

export const ProvidersPage: React.FC = () => {
  const providersQuery = useQuery(providersQueryOptions());
  const pluginsQuery = useQuery(pluginsQueryOptions());
  const providers = providersQuery.data?.providers ?? [];
  const plugins = pluginsQuery.data?.plugins ?? [];
  const isLoading = providersQuery.isLoading || pluginsQuery.isLoading;

  return (
    <PageContainer
      title={m["dashboard.providers.list_title"]()}
      extra={
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button data-testid="new-provider-button" />}>
            {m["dashboard.providers.new_provider"]()}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
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
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <section className="space-y-3" aria-labelledby="plugins-heading">
            <h2 id="plugins-heading" className="text-sm font-semibold">
              {m["dashboard.providers.plugins.title"]()}
            </h2>
            <PluginsTable plugins={plugins} />
          </section>

          <section className="space-y-3" aria-labelledby="providers-heading">
            <h2 id="providers-heading" className="text-sm font-semibold">
              {m["dashboard.providers.providers_title"]()}
            </h2>
            <ProvidersTable providers={providers} />
          </section>
        </div>
      )}
    </PageContainer>
  );
};
