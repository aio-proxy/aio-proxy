import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@aio-proxy/ui/components/popover';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@aio-proxy/ui/components/sheet';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import { cn } from '@aio-proxy/ui/lib/utils';
import { enUS, zhCN } from 'date-fns/locale';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

import { cloneValidDate, createDateTimeRangeDraft } from './date-time-range';
import { DateTimeRangePickerPanel } from './date-time-range-picker-panel';
import type { DateTimeRange, DateTimeRangePreset } from './date-time-range-picker.types';

export interface DateTimeRangePickerProps {
  value?: DateTimeRange | undefined;
  presets?: readonly DateTimeRangePreset[] | undefined;
  pattern?: string | undefined;
  min?: Date | undefined;
  max?: Date | undefined;
  disabled?: boolean | undefined;
  trigger?: React.ReactElement | undefined;
  onChange: (value: DateTimeRange) => void;
}

const DEFAULT_PATTERN = "yyyy-MM-dd'T'HH:mm";

const formatTriggerEndpoint = (text: string) => text.replace('T', ' ');

export const DateTimeRangePicker: React.FC<DateTimeRangePickerProps> = ({
  value,
  presets = [],
  pattern = DEFAULT_PATTERN,
  min,
  max,
  disabled,
  trigger,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const locale = getLocale() === 'zh-Hans' ? zhCN : enUS;
  const minimum = cloneValidDate(min);
  const maximum = cloneValidDate(max);
  const draft = createDateTimeRangeDraft(value, pattern, locale);
  const hasRange = Boolean(draft.from && draft.to);
  const summary = hasRange
    ? `${formatTriggerEndpoint(draft.from)} – ${formatTriggerEndpoint(draft.to)}`
    : m['dashboard.date_time_range_picker.title']();
  const triggerElement = trigger ?? (
    <Button
      type="button"
      variant="ghost"
      className="w-full justify-between overflow-hidden border-transparent bg-input/50 bg-clip-border font-normal hover:bg-input/50 aria-expanded:bg-input/50"
      aria-label={m['dashboard.date_time_range_picker.title']()}
    />
  );
  const triggerChildren =
    trigger === undefined ? (
      <>
        <span className={cn('min-w-0 flex-1 truncate text-left', !hasRange && 'text-muted-foreground')}>{summary}</span>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </>
    ) : undefined;
  const pickerTrigger = mobile ? (
    <SheetTrigger render={triggerElement} disabled={disabled}>
      {triggerChildren}
    </SheetTrigger>
  ) : (
    <PopoverTrigger render={triggerElement} disabled={disabled}>
      {triggerChildren}
    </PopoverTrigger>
  );
  const panel = open && (
    <DateTimeRangePickerPanel
      value={value}
      presets={presets}
      pattern={pattern}
      locale={locale}
      min={minimum}
      max={maximum}
      mobile={mobile}
      onChange={(next) => {
        onChange(next);
        setOpen(false);
      }}
    />
  );

  return mobile ? (
    <Sheet open={open} onOpenChange={setOpen}>
      {pickerTrigger}
      <SheetContent side="bottom" className="max-h-[90dvh] rounded-t-3xl p-0">
        <SheetTitle className="p-6 pr-16 pb-4">{m['dashboard.date_time_range_picker.title']()}</SheetTitle>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">{panel}</div>
      </SheetContent>
    </Sheet>
  ) : (
    <Popover open={open} onOpenChange={setOpen}>
      {pickerTrigger}
      <PopoverContent className="w-auto" align="start" sideOffset={-32}>
        {panel}
      </PopoverContent>
    </Popover>
  );
};
