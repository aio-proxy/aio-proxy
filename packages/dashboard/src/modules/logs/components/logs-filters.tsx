import { m } from "@aio-proxy/i18n";
import { ProviderProtocol, type RequestOutcome } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";
import { endOfDay, startOfDay } from "date-fns";
import { RefreshCw, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { z } from "zod";

import { DateTimeRangePicker } from "@/components/date-time-range-picker";
import { ProtocolLabel } from "@/components/protocol-label";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { createLogsDateTimeRangePresets, toPickerRange, toQueryRange } from "../log-date-range";
import { createDefaultLogsSearch, type LogsFilterPatch, type LogsSearch, withLogsFilters } from "../logs-search";
import { LogsAdvancedFilters } from "./logs-advanced-filters";

interface LogsFiltersProps {
  readonly search: LogsSearch;
  readonly autoRefresh: boolean;
  readonly refreshing: boolean;
  readonly onChange: (search: LogsSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
  readonly onRefresh: () => void;
}

const schema = z.object({
  outcome: z.string(),
  inboundProtocol: z.string(),
  requestedModelId: z.string(),
  dateRange: z.object({ from: z.date(), to: z.date() }).optional(),
  autoRefresh: z.boolean(),
});

export const LogsFilters: React.FC<LogsFiltersProps> = ({
  search,
  autoRefresh,
  refreshing,
  onChange,
  onAutoRefresh,
  onRefresh,
}) => {
  const now = new Date();
  const retentionStart = startOfDay(new Date(now.getTime() - 45 * 86_400_000));
  const defaultValues: z.input<typeof schema> = {
    outcome: search.outcome ?? "",
    inboundProtocol: search.inboundProtocol ?? "",
    requestedModelId: search.requestedModelId ?? "",
    dateRange: toPickerRange(search),
    autoRefresh,
  };
  const form = useForm({
    defaultValues,
    validators: { onChange: schema },
  });
  const patch = (value: LogsFilterPatch) => onChange(withLogsFilters(search, value));
  const { startedAfter, completedBefore, outcome, inboundProtocol, requestedModelId } = search;

  useEffect(() => {
    form.setFieldValue("dateRange", toPickerRange({ startedAfter, completedBefore }));
    form.setFieldValue("outcome", outcome ?? "");
    form.setFieldValue("inboundProtocol", inboundProtocol ?? "");
    form.setFieldValue("requestedModelId", requestedModelId ?? "");
  }, [form, startedAfter, completedBefore, outcome, inboundProtocol, requestedModelId]);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <form.Field name="dateRange">
        {(field) => (
          <Field className="w-auto min-w-60 flex-1">
            <FieldLabel>{m["dashboard.logs.range"]()}</FieldLabel>
            <DateTimeRangePicker
              value={field.state.value}
              presets={createLogsDateTimeRangePresets()}
              min={retentionStart}
              max={endOfDay(now)}
              onChange={(value) => {
                field.handleChange(value);
                patch(toQueryRange(value));
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="requestedModelId">
        {(field) => (
          <Field className="w-auto min-w-52 flex-1">
            <FieldLabel htmlFor="logs-requestedModelId">{m["dashboard.logs.requested_model"]()}</FieldLabel>
            <Input
              id="logs-requestedModelId"
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                patch({ requestedModelId: event.target.value || undefined });
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="outcome">
        {(field) => (
          <Field className="w-36">
            <FieldLabel>{m["dashboard.logs.outcome"]()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                const next = value ?? "";
                field.handleChange(next);
                patch({ outcome: (next || undefined) as RequestOutcome | undefined });
              }}
            >
              <SelectTrigger className="w-full" aria-label={m["dashboard.logs.outcome"]()}>
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
          <Field className="w-44">
            <FieldLabel>{m["dashboard.logs.protocol"]()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                const next = value ?? "";
                field.handleChange(next);
                patch({ inboundProtocol: next || undefined });
              }}
            >
              <SelectTrigger className="w-full" aria-label={m["dashboard.logs.protocol"]()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{m["dashboard.logs.all"]()}</SelectItem>
                {Object.values(ProviderProtocol).map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    <ProtocolLabel protocol={protocol} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <LogsAdvancedFilters search={search} onChange={patch} />
      {search.page === 1 && (
        <form.Field name="autoRefresh">
          {(field) => (
            <Field orientation="horizontal" className="h-9 w-auto px-1">
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
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={m["dashboard.logs.reset"]()}
        onClick={() => onChange(createDefaultLogsSearch())}
      >
        <RotateCcw />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={m["dashboard.logs.refresh"]()}
        onClick={onRefresh}
      >
        <RefreshCw className={refreshing ? "animate-spin" : ""} />
      </Button>
    </div>
  );
};
