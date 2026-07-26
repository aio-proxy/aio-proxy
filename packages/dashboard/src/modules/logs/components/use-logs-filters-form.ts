import { useForm } from '@tanstack/react-form';
import { useEffect } from 'react';
import { z } from 'zod';

import { toPickerRange } from '../log-date-range';
import type { LogsSearch } from '../logs-search';

const schema = z.object({
  outcome: z.string(),
  inboundProtocol: z.string(),
  requestedModelId: z.string(),
  dateRange: z.object({ from: z.date(), to: z.date() }).optional(),
  autoRefresh: z.boolean(),
});

export const useLogsFiltersForm = (search: LogsSearch, autoRefresh: boolean) => {
  const defaultValues: z.input<typeof schema> = {
    outcome: search.outcome ?? '',
    inboundProtocol: search.inboundProtocol ?? '',
    requestedModelId: search.requestedModelId ?? '',
    dateRange: toPickerRange(search),
    autoRefresh,
  };
  const form = useForm({
    defaultValues,
    validators: { onChange: schema },
  });
  const { startedAfter, completedBefore, outcome, inboundProtocol, requestedModelId } = search;

  useEffect(() => {
    form.setFieldValue('dateRange', toPickerRange({ startedAfter, completedBefore }));
    form.setFieldValue('outcome', outcome ?? '');
    form.setFieldValue('inboundProtocol', inboundProtocol ?? '');
    form.setFieldValue('requestedModelId', requestedModelId ?? '');
  }, [form, startedAfter, completedBefore, outcome, inboundProtocol, requestedModelId]);

  return form;
};
