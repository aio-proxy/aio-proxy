import { m } from "@aio-proxy/i18n";
import { useForm } from "@tanstack/react-form";
import { ListFilter } from "lucide-react";
import { useEffect } from "react";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import type { LogsSearch } from "../logs-search";

type AdvancedFilterKey = "requestId" | "finalProviderId" | "finalModelId" | "finalStatusCode";
type AdvancedFiltersPatch = {
  [Key in AdvancedFilterKey]?: LogsSearch[Key] | undefined;
};

interface LogsAdvancedFiltersProps {
  readonly search: LogsSearch;
  readonly onChange: (patch: AdvancedFiltersPatch) => void;
}

const schema = z.object({
  requestId: z.string(),
  finalProviderId: z.string(),
  finalModelId: z.string(),
  finalStatusCode: z.string(),
});

export const LogsAdvancedFilters: React.FC<LogsAdvancedFiltersProps> = ({ search, onChange }) => {
  const form = useForm({
    defaultValues: {
      requestId: search.requestId ?? "",
      finalProviderId: search.finalProviderId ?? "",
      finalModelId: search.finalModelId ?? "",
      finalStatusCode: search.finalStatusCode?.toString() ?? "",
    },
    validators: { onChange: schema },
  });
  useEffect(() => {
    form.setFieldValue("requestId", search.requestId ?? "");
    form.setFieldValue("finalProviderId", search.finalProviderId ?? "");
    form.setFieldValue("finalModelId", search.finalModelId ?? "");
    form.setFieldValue("finalStatusCode", search.finalStatusCode?.toString() ?? "");
  }, [form, search.requestId, search.finalProviderId, search.finalModelId, search.finalStatusCode]);
  const activeCount = [search.requestId, search.finalProviderId, search.finalModelId, search.finalStatusCode].filter(
    (value) => value !== undefined,
  ).length;
  const textField = (name: "requestId" | "finalProviderId" | "finalModelId", label: string) => (
    <form.Field name={name}>
      {(field) => (
        <Field>
          <FieldLabel htmlFor={`logs-${name}`}>{label}</FieldLabel>
          <Input
            id={`logs-${name}`}
            value={field.state.value}
            onChange={(event) => {
              field.handleChange(event.target.value);
              onChange({ [name]: event.target.value || undefined });
            }}
          />
        </Field>
      )}
    </form.Field>
  );
  const clearFilters = () => {
    form.reset({ requestId: "", finalProviderId: "", finalModelId: "", finalStatusCode: "" });
    onChange({ requestId: undefined, finalProviderId: undefined, finalModelId: undefined, finalStatusCode: undefined });
  };

  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" variant="outline" />}>
        <ListFilter />
        {m["dashboard.logs.more_filters"]()}
        {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <div className="grid gap-3">
          {textField("requestId", m["dashboard.logs.request_id"]())}
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
                    onChange({
                      finalStatusCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
                    });
                  }}
                />
              </Field>
            )}
          </form.Field>
          <Button type="button" variant="ghost" size="sm" disabled={activeCount === 0} onClick={clearFilters}>
            {m["dashboard.logs.clear_advanced_filters"]()}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
