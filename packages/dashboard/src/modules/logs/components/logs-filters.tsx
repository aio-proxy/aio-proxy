import { m } from "@aio-proxy/i18n";
import type { DashboardRequestLogsPageSize, RequestOutcome } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toPickerRange, toQueryRange } from "../log-date-range";
import { createDefaultLogsSearch, type LogsSearch, withLogsFilters } from "../logs-search";
import { LogsDateRangePicker } from "./logs-date-range-picker";

type Props = {
  readonly search: LogsSearch;
  readonly autoRefresh: boolean;
  readonly refreshing: boolean;
  readonly onChange: (search: LogsSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
  readonly onRefresh: () => void;
};
const schema = z.object({
  requestId: z.string(),
  outcome: z.string(),
  inboundProtocol: z.string(),
  requestedModelId: z.string(),
  finalProviderId: z.string(),
  finalModelId: z.string(),
  finalStatusCode: z.string(),
  dateRange: z.object({ from: z.date().optional(), to: z.date().optional() }),
  pageSize: z.number(),
  autoRefresh: z.boolean(),
});
const protocols = ["openai-compatible", "openai-response", "anthropic", "gemini"];

export const LogsFilters: React.FC<Props> = ({
  search,
  autoRefresh,
  refreshing,
  onChange,
  onAutoRefresh,
  onRefresh,
}) => {
  const form = useForm({
    defaultValues: {
      requestId: search.requestId ?? "",
      outcome: search.outcome ?? "",
      inboundProtocol: search.inboundProtocol ?? "",
      requestedModelId: search.requestedModelId ?? "",
      finalProviderId: search.finalProviderId ?? "",
      finalModelId: search.finalModelId ?? "",
      finalStatusCode: search.finalStatusCode?.toString() ?? "",
      dateRange: toPickerRange(search),
      pageSize: search.pageSize,
      autoRefresh,
    },
    validators: { onChange: schema },
  });
  const patch = (value: Partial<Omit<LogsSearch, "page">>) => onChange(withLogsFilters(search, value));
  const { startedAfter, completedBefore } = search;
  useEffect(() => {
    form.setFieldValue("dateRange", toPickerRange({ startedAfter, completedBefore }));
  }, [form, startedAfter, completedBefore]);
  const textField = (name: "requestId" | "requestedModelId" | "finalProviderId" | "finalModelId", label: string) => (
    <form.Field name={name}>
      {(field) => (
        <Field>
          <FieldLabel htmlFor={`logs-${name}`}>{label}</FieldLabel>
          <Input
            id={`logs-${name}`}
            value={field.state.value}
            onChange={(event) => {
              field.handleChange(event.target.value);
              patch({ [name]: event.target.value || undefined });
            }}
          />
        </Field>
      )}
    </form.Field>
  );
  return (
    <div className="space-y-3 rounded-2xl border p-3">
      <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-5">
        <form.Field name="dateRange">
          {(field) => (
            <Field>
              <FieldLabel>{m["dashboard.logs.range"]()}</FieldLabel>
              <LogsDateRangePicker
                value={field.state.value}
                onChange={(value) => {
                  field.handleChange(value);
                  const query = toQueryRange(value);
                  if (query) patch(query);
                }}
              />
            </Field>
          )}
        </form.Field>
        {textField("requestId", m["dashboard.logs.request_id"]())}
        <form.Field name="outcome">
          {(field) => (
            <Field>
              <FieldLabel>{m["dashboard.logs.outcome"]()}</FieldLabel>
              <Select
                value={field.state.value}
                onValueChange={(value) => {
                  const next = value ?? "";
                  field.handleChange(next);
                  patch({ outcome: (next || undefined) as RequestOutcome | undefined });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{m["dashboard.logs.all"]()}</SelectItem>
                  <SelectItem value="success">{m["dashboard.logs.success"]()}</SelectItem>
                  <SelectItem value="failure">{m["dashboard.logs.failure"]()}</SelectItem>
                  <SelectItem value="cancelled">{m["dashboard.logs.cancelled"]()}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="inboundProtocol">
          {(field) => (
            <Field>
              <FieldLabel>{m["dashboard.logs.protocol"]()}</FieldLabel>
              <Select
                value={field.state.value}
                onValueChange={(value) => {
                  const next = value ?? "";
                  field.handleChange(next);
                  patch({ inboundProtocol: next || undefined });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{m["dashboard.logs.all"]()}</SelectItem>
                  {protocols.map((protocol) => (
                    <SelectItem key={protocol} value={protocol}>
                      {protocol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
        {textField("requestedModelId", m["dashboard.logs.requested_model"]())}
        {textField("finalProviderId", m["dashboard.logs.final_provider"]())}
        {textField("finalModelId", m["dashboard.logs.final_model"]())}
        <form.Field name="finalStatusCode">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="logs-status">{m["dashboard.logs.status"]()}</FieldLabel>
              <Input
                id="logs-status"
                type="number"
                min={100}
                max={599}
                value={field.state.value}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  const status = Number(event.target.value);
                  patch({
                    finalStatusCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
                  });
                }}
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="pageSize">
          {(field) => (
            <Field>
              <FieldLabel>{m["dashboard.logs.page_size"]()}</FieldLabel>
              <Select
                value={String(field.state.value)}
                onValueChange={(value) => {
                  if (value === null) return;
                  const size = Number(value) as DashboardRequestLogsPageSize;
                  field.handleChange(size);
                  patch({ pageSize: size });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 50, 100].map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
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
          <form.Field name="autoRefresh">
            {(field) => (
              <Field orientation="horizontal">
                <Switch
                  id="logs-auto-refresh"
                  checked={field.state.value}
                  onCheckedChange={(value) => {
                    field.handleChange(value);
                    onAutoRefresh(value);
                  }}
                />
                <FieldLabel htmlFor="logs-auto-refresh">{m["dashboard.logs.auto_refresh"]()}</FieldLabel>
              </Field>
            )}
          </form.Field>
        )}
      </div>
    </div>
  );
};
