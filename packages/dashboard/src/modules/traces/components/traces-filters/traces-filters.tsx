import { m } from '@aio-proxy/i18n';
import type { OtelSpanStatusCode } from '@aio-proxy/types';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@aio-proxy/ui/components/accordion';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@aio-proxy/ui/components/sidebar';
import { Switch } from '@aio-proxy/ui/components/switch';
import { useForm } from '@tanstack/react-form';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { z } from 'zod';

import { PROTOCOL_ORDER, ProtocolLabel } from '@/components/protocol-label';

import {
  createDefaultTraceSearch,
  type TraceFilterPatch,
  type TraceSearch,
  withTraceFilters,
} from '../../lib/trace-search';
import { TracesRequestFilters } from '../traces-request-filters';
import { TracesResultFilters } from '../traces-result-filters';

interface TracesFiltersProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly refreshing: boolean;
  readonly onChange: (search: TraceSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
  readonly onRefresh: () => void;
}

const schema = z.object({
  requestedModelId: z.string(),
  otelStatusCode: z.string(),
  inboundProtocol: z.string(),
  autoRefresh: z.boolean(),
});

export const TracesFilters: React.FC<TracesFiltersProps> = ({
  search,
  autoRefresh,
  refreshing,
  onChange,
  onAutoRefresh,
  onRefresh,
}) => {
  const form = useForm({
    defaultValues: {
      requestedModelId: search.requestedModelId ?? '',
      otelStatusCode: search.otelStatusCode ?? '',
      inboundProtocol: search.inboundProtocol ?? '',
      autoRefresh,
    },
    validators: { onChange: schema },
  });
  const patch = (value: TraceFilterPatch) => onChange(withTraceFilters(search, value));
  const { requestedModelId, otelStatusCode, inboundProtocol } = search;

  useEffect(() => {
    form.setFieldValue('requestedModelId', requestedModelId ?? '');
    form.setFieldValue('otelStatusCode', otelStatusCode ?? '');
    form.setFieldValue('inboundProtocol', inboundProtocol ?? '');
  }, [form, requestedModelId, otelStatusCode, inboundProtocol]);

  // 工具栏的实时按钮和这个开关绑同一个 autoRefresh，从工具栏改过来时要跟上。
  useEffect(() => {
    form.setFieldValue('autoRefresh', autoRefresh);
  }, [form, autoRefresh]);

  return (
    <Sidebar
      id="traces-filters"
      className="absolute! inset-y-0! h-full! border-r"
      aria-label={m['dashboard.traces.filters']()}
    >
      <SidebarHeader className="flex h-12 justify-center border-b px-4">
        <h2 className="font-heading text-base font-medium">{m['dashboard.traces.filters']()}</h2>
      </SidebarHeader>
      <SidebarContent>
        <Accordion multiple defaultValue={['request']} className="rounded-none border-0 **:data-open:bg-transparent">
          <AccordionItem value="request">
            <AccordionTrigger className="px-3 py-2.5 hover:no-underline">
              {m['dashboard.traces.request_tab']()}
            </AccordionTrigger>
            <AccordionContent className="pb-3">
              <div className="grid gap-3">
                <form.Field name="requestedModelId">
                  {(field) => (
                    <Field className="w-full">
                      <FieldLabel htmlFor="traces-requested-model">
                        {m['dashboard.traces.requested_model']()}
                      </FieldLabel>
                      <Input
                        id="traces-requested-model"
                        value={field.state.value}
                        onChange={(event) => {
                          field.handleChange(event.target.value);
                          patch({ requestedModelId: event.target.value || undefined });
                        }}
                      />
                    </Field>
                  )}
                </form.Field>
                <form.Field name="inboundProtocol">
                  {(field) => (
                    <Field className="w-full">
                      <FieldLabel>{m['dashboard.traces.protocol']()}</FieldLabel>
                      <Select
                        value={field.state.value}
                        onValueChange={(value) => {
                          const next = value ?? '';
                          field.handleChange(next);
                          patch({ inboundProtocol: next || undefined });
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label={m['dashboard.traces.protocol']()}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{m['dashboard.traces.all']()}</SelectItem>
                          {PROTOCOL_ORDER.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>
                              <ProtocolLabel protocol={protocol} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </form.Field>
                <TracesRequestFilters search={search} onChange={patch} />
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="result">
            <AccordionTrigger className="px-3 py-2.5 hover:no-underline">
              {m['dashboard.traces.result_details']()}
            </AccordionTrigger>
            <AccordionContent className="pb-3">
              <div className="grid gap-3">
                <form.Field name="otelStatusCode">
                  {(field) => (
                    <Field className="w-full">
                      <FieldLabel>{m['dashboard.traces.otel_status']()}</FieldLabel>
                      <Select
                        value={field.state.value}
                        onValueChange={(value) => {
                          const next = value ?? '';
                          field.handleChange(next);
                          patch({ otelStatusCode: (next || undefined) as OtelSpanStatusCode | undefined });
                        }}
                      >
                        <SelectTrigger className="w-full" aria-label={m['dashboard.traces.otel_status']()}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{m['dashboard.traces.all']()}</SelectItem>
                          <SelectItem value="UNSET">UNSET</SelectItem>
                          <SelectItem value="OK">OK</SelectItem>
                          <SelectItem value="ERROR">ERROR</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </form.Field>
                <TracesResultFilters search={search} onChange={patch} />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </SidebarContent>
      <SidebarFooter className="flex flex-row items-center justify-end gap-2">
        {search.pageToken === undefined && (
          <form.Field name="autoRefresh">
            {(field) => (
              <Field orientation="horizontal" className="h-9 w-auto px-1">
                <Switch
                  id="traces-auto-refresh"
                  checked={field.state.value}
                  onCheckedChange={(value) => {
                    field.handleChange(value);
                    onAutoRefresh(value);
                  }}
                />
                <FieldLabel htmlFor="traces-auto-refresh">{m['dashboard.traces.auto_refresh']()}</FieldLabel>
              </Field>
            )}
          </form.Field>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={m['dashboard.traces.reset']()}
          onClick={() => onChange(createDefaultTraceSearch())}
        >
          <RotateCcw />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={m['dashboard.traces.refresh']()}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? 'animate-spin' : ''} />
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
};
