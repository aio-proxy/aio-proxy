import { m } from "@aio-proxy/i18n";
import type { DashboardRequestLog, DashboardRequestLogsPageSize, RequestOutcome } from "@aio-proxy/types";
import { Clipboard, RefreshCw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { DataTablePagination } from "@/components/data-table-pagination";
import { PageContainer } from "@/components/page-container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLogsQuery } from "../hooks/use-logs-query";
import { displayTotalTokens, formatDuration, formatLogCost, formatLogNumber } from "../log-formatters";
import { createDefaultLogsSearch, type LogsSearch, withLogsFilters } from "../logs-search";

type Props = { readonly search: LogsSearch; readonly onSearchChange: (search: LogsSearch) => void };

const protocols = ["openai-compatible", "openai-response", "anthropic", "gemini"];

export function LogsPage({ search, onSearchChange }: Props) {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<DashboardRequestLog>();
  const query = useLogsQuery(search, autoRefresh);
  const data = query.data;
  const paginationTable = useMemo(
    () => ({
      getState: () => ({ pagination: { pageIndex: search.page - 1, pageSize: search.pageSize } }),
      getPageOptions: () => Array.from({ length: data?.pageCount ?? 0 }, (_, index) => index),
      getCanPreviousPage: () => search.page > 1,
      getCanNextPage: () => search.page < (data?.pageCount ?? 0),
      previousPage: () => onSearchChange({ ...search, page: search.page - 1 }),
      nextPage: () => onSearchChange({ ...search, page: search.page + 1 }),
      setPageIndex: (pageIndex: number) => onSearchChange({ ...search, page: pageIndex + 1 }),
    }),
    [data?.pageCount, onSearchChange, search],
  );

  return (
    <PageContainer title={m["dashboard.logs.title"]()}>
      <div className="space-y-4">
        <LogsFilters
          search={search}
          autoRefresh={autoRefresh}
          refreshing={query.isFetching}
          onChange={onSearchChange}
          onAutoRefresh={setAutoRefresh}
          onRefresh={() => void query.refetch()}
        />
        {query.isLoading ? (
          <div className="space-y-2" role="status" aria-label={m["dashboard.logs.loading"]()}>
            {["a", "b", "c", "d", "e", "f"].map((key) => (
              <Skeleton className="h-12 w-full" key={key} />
            ))}
          </div>
        ) : query.isError ? (
          <Empty>
            <EmptyTitle>{m["dashboard.logs.error_title"]()}</EmptyTitle>
            <EmptyDescription>{m["dashboard.logs.error_description"]()}</EmptyDescription>
            <Button onClick={() => void query.refetch()}>{m["dashboard.logs.refresh"]()}</Button>
          </Empty>
        ) : data?.items.length === 0 ? (
          <Empty>
            <EmptyTitle>{m["dashboard.logs.empty_title"]()}</EmptyTitle>
            <EmptyDescription>{m["dashboard.logs.empty_description"]()}</EmptyDescription>
            <Button onClick={() => onSearchChange(createDefaultLogsSearch())}>{m["dashboard.logs.reset"]()}</Button>
          </Empty>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded-2xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m["dashboard.logs.completed_at"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.outcome"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.protocol"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.requested_model"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.final_provider"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.final_model"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.status"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.duration"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.tokens"]()}</TableHead>
                    <TableHead>{m["dashboard.logs.cost"]()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.items.map((log: DashboardRequestLog) => (
                    <TableRow
                      key={log.requestId}
                      tabIndex={0}
                      role="button"
                      aria-label={`${m["dashboard.logs.details"]()}: ${log.requestId}`}
                      className="cursor-pointer"
                      onClick={() => setSelected(log)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(log);
                        }
                      }}
                    >
                      <TableCell className="whitespace-nowrap">{new Date(log.completedAt).toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{outcomeLabel(log.outcome)}</Badge>
                      </TableCell>
                      <TableCell>{log.inboundProtocol}</TableCell>
                      <TableCell>{log.requestedModelId}</TableCell>
                      <TableCell>{log.finalProviderId ?? "—"}</TableCell>
                      <TableCell>{log.finalModelId ?? "—"}</TableCell>
                      <TableCell>{log.finalStatusCode ?? "—"}</TableCell>
                      <TableCell>{formatDuration(log.durationMs)}</TableCell>
                      <TableCell>{formatLogNumber(displayTotalTokens(log.usage))}</TableCell>
                      <TableCell>{formatLogCost(log.usage?.estimatedCostUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-muted-foreground text-sm">
                {m["dashboard.logs.page_size"]()}
                <select
                  className="h-9 rounded-xl bg-input/50 px-3"
                  value={search.pageSize}
                  onChange={(event) =>
                    onSearchChange(
                      withLogsFilters(search, { pageSize: Number(event.target.value) as DashboardRequestLogsPageSize }),
                    )
                  }
                >
                  {[10, 20, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <DataTablePagination table={paginationTable as never} />
            </div>
          </div>
        )}
      </div>
      <LogDetailDrawer log={selected} onClose={() => setSelected(undefined)} />
    </PageContainer>
  );
}

function LogsFilters({
  search,
  autoRefresh,
  refreshing,
  onChange,
  onAutoRefresh,
  onRefresh,
}: {
  readonly search: LogsSearch;
  readonly autoRefresh: boolean;
  readonly refreshing: boolean;
  readonly onChange: (search: LogsSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
  readonly onRefresh: () => void;
}) {
  const patch = (value: Partial<Omit<LogsSearch, "page">>) => onChange(withLogsFilters(search, value));
  const preset = (days: number) => {
    const end = new Date();
    patch({
      startedAfter: new Date(end.getTime() - days * 24 * 60 * 60 * 1_000).toISOString(),
      completedBefore: end.toISOString(),
    });
  };
  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <div className="flex flex-wrap gap-2">
        {[
          [1, "range_24h"],
          [7, "range_7d"],
          [14, "range_14d"],
          [30, "range_30d"],
          [45, "range_45d"],
        ].map(([days, key]) => (
          <Button key={key} size="sm" variant="outline" onClick={() => preset(days as number)}>
            {m[`dashboard.logs.${key}` as "dashboard.logs.range_24h"]()}
          </Button>
        ))}
      </div>
      <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-5">
        <FilterInput
          label={m["dashboard.logs.start"]()}
          type="datetime-local"
          value={toLocalInput(search.startedAfter)}
          onChange={(value) => patch({ startedAfter: new Date(value).toISOString() })}
        />
        <FilterInput
          label={m["dashboard.logs.end"]()}
          type="datetime-local"
          value={toLocalInput(search.completedBefore)}
          onChange={(value) => patch({ completedBefore: new Date(value).toISOString() })}
        />
        <FilterInput
          label={m["dashboard.logs.request_id"]()}
          value={search.requestId ?? ""}
          onChange={(value) => patch({ requestId: value || undefined })}
        />
        <label className="space-y-1 text-muted-foreground text-xs">
          {m["dashboard.logs.outcome"]()}
          <select
            className="h-9 w-full rounded-xl bg-input/50 px-3 text-foreground text-sm"
            value={search.outcome ?? ""}
            onChange={(event) => patch({ outcome: (event.target.value || undefined) as RequestOutcome | undefined })}
          >
            <option value="">{m["dashboard.logs.all"]()}</option>
            <option value="success">{m["dashboard.logs.success"]()}</option>
            <option value="failure">{m["dashboard.logs.failure"]()}</option>
            <option value="cancelled">{m["dashboard.logs.cancelled"]()}</option>
          </select>
        </label>
        <label className="space-y-1 text-muted-foreground text-xs">
          {m["dashboard.logs.protocol"]()}
          <select
            className="h-9 w-full rounded-xl bg-input/50 px-3 text-foreground text-sm"
            value={search.inboundProtocol ?? ""}
            onChange={(event) => patch({ inboundProtocol: event.target.value || undefined })}
          >
            <option value="">{m["dashboard.logs.all"]()}</option>
            {protocols.map((protocol) => (
              <option key={protocol}>{protocol}</option>
            ))}
          </select>
        </label>
        <FilterInput
          label={m["dashboard.logs.requested_model"]()}
          value={search.requestedModelId ?? ""}
          onChange={(value) => patch({ requestedModelId: value || undefined })}
        />
        <FilterInput
          label={m["dashboard.logs.final_provider"]()}
          value={search.finalProviderId ?? ""}
          onChange={(value) => patch({ finalProviderId: value || undefined })}
        />
        <FilterInput
          label={m["dashboard.logs.final_model"]()}
          value={search.finalModelId ?? ""}
          onChange={(value) => patch({ finalModelId: value || undefined })}
        />
        <FilterInput
          label={m["dashboard.logs.status"]()}
          type="number"
          value={search.finalStatusCode?.toString() ?? ""}
          onChange={(value) => patch({ finalStatusCode: value ? Number(value) : undefined })}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onChange(createDefaultLogsSearch())}>
          {m["dashboard.logs.reset"]()}
        </Button>
        <Button variant="outline" onClick={onRefresh}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          {m["dashboard.logs.refresh"]()}
        </Button>
        {search.page === 1 && (
          <label className="flex items-center gap-2 text-sm" htmlFor="logs-auto-refresh">
            <Switch id="logs-auto-refresh" checked={autoRefresh} onCheckedChange={onAutoRefresh} />
            {m["dashboard.logs.auto_refresh"]()}
          </label>
        )}
      </div>
    </div>
  );
}

function FilterInput({
  label,
  value,
  type = "text",
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly type?: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label className="space-y-1 text-muted-foreground text-xs" htmlFor={id}>
      {label}
      <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function LogDetailDrawer({
  log,
  onClose,
}: {
  readonly log: DashboardRequestLog | undefined;
  readonly onClose: () => void;
}) {
  return (
    <Drawer
      open={log !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      swipeDirection="right"
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{m["dashboard.logs.details"]()}</DrawerTitle>
          <DrawerDescription>{log?.requestId}</DrawerDescription>
        </DrawerHeader>
        {log && (
          <ScrollArea className="min-h-0 flex-1 p-4">
            <div className="space-y-5">
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(log.requestId)}>
                <Clipboard />
                {m["dashboard.logs.copy_id"]()}
              </Button>
              <DetailSection
                title={m["dashboard.logs.summary"]()}
                rows={[
                  [m["dashboard.logs.outcome"](), outcomeLabel(log.outcome)],
                  [m["dashboard.logs.protocol"](), log.inboundProtocol],
                  [m["dashboard.logs.requested_model"](), log.requestedModelId],
                  [m["dashboard.logs.final_provider"](), log.finalProviderId],
                  [m["dashboard.logs.final_model"](), log.finalModelId],
                  [m["dashboard.logs.status"](), log.finalStatusCode],
                  [m["dashboard.logs.error_code"](), log.errorCode],
                  [m["dashboard.logs.started_at"](), new Date(log.startedAt).toLocaleString()],
                  [m["dashboard.logs.completed_at"](), new Date(log.completedAt).toLocaleString()],
                  [m["dashboard.logs.duration"](), formatDuration(log.durationMs)],
                ]}
              />
              <DetailSection
                title={m["dashboard.logs.usage"]()}
                rows={[
                  [m["dashboard.logs.input_tokens"](), log.usage?.inputTokens],
                  [m["dashboard.logs.output_tokens"](), log.usage?.outputTokens],
                  [m["dashboard.logs.tokens"](), displayTotalTokens(log.usage)],
                  [m["dashboard.logs.cache_read_tokens"](), log.usage?.cacheReadTokens],
                  [m["dashboard.logs.cache_write_tokens"](), log.usage?.cacheWriteTokens],
                  [m["dashboard.logs.reasoning_tokens"](), log.usage?.reasoningTokens],
                  [m["dashboard.logs.cost"](), formatLogCost(log.usage?.estimatedCostUsd)],
                ]}
              />
              <section>
                <h3 className="mb-2 font-medium">{m["dashboard.logs.attempts"]()}</h3>
                <div className="space-y-2">
                  {log.attempts.map((attempt) => (
                    <div className="rounded-xl border p-3 text-sm" key={attempt.index}>
                      <div className="font-medium">
                        #{attempt.index + 1} · {attempt.providerId} / {attempt.modelId}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {attempt.providerKind} · {attempt.protocol ?? "—"} · {outcomeLabel(attempt.outcome)} ·{" "}
                        {attempt.statusCode ?? "—"} · {formatDuration(attempt.durationMs)}
                        {attempt.errorCode ? ` · ${attempt.errorCode}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </ScrollArea>
        )}
        <DrawerFooter>
          <DrawerClose render={<Button variant="outline" />}>{m["dashboard.logs.close"]()}</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function DetailSection({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly (readonly [string, unknown])[];
}) {
  return (
    <section>
      <h3 className="mb-2 font-medium">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-right">{value === undefined ? "—" : String(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const outcomeLabel = (outcome: RequestOutcome) => m[`dashboard.logs.${outcome}`]();
const toLocalInput = (iso: string) => {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};
