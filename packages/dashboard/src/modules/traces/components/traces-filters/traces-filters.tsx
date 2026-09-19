import { m } from '@aio-proxy/i18n';
import type { OtelSpanStatusCode } from '@aio-proxy/types';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@aio-proxy/ui/components/accordion';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, useSidebar } from '@aio-proxy/ui/components/sidebar';
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
  const { open, isMobile } = useSidebar();
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
      className="absolute! inset-y-0! h-full! border-r"
      // offcanvas 收起来只是把面板平移出屏幕，既不 hidden 也不 inert：工具栏那颗按钮报着
      // aria-expanded="false"，键盘却还能 tab 进一整片看不见的筛选控件。移动端那份是
      // Dialog，收起时整块不在 DOM 里，`Sidebar` 也不会把这个属性转下去。
      inert={!isMobile && !open}
    >
      <SidebarHeader className="flex h-12 justify-center border-b px-4">
        <h2 className="font-heading text-base font-medium">{m['dashboard.traces.filters']()}</h2>
      </SidebarHeader>
      {/* id 和可读名字挂在这里而不是 `Sidebar` 上：移动端 `Sidebar` 把 props 转给 Base UI 的
          Dialog.Root，它不渲染任何节点，两个属性会被静默丢掉，工具栏就指着一个不存在的元素。 */}
      <SidebarContent id="traces-filters" role="group" aria-label={m['dashboard.traces.filters']()}>
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
