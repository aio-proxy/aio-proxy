import { getLocale, m } from "@aio-proxy/i18n";
import { enUS, zhCN } from "date-fns/locale";
import { CalendarIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

import type { DateTimeRange, DateTimeRangePreset } from "./date-time-range-picker.types";

import { cloneValidDate, createDateTimeRangeDraft } from "./date-time-range";
import { DateTimeRangePickerPanel } from "./date-time-range-picker-panel";

export interface DateTimeRangePickerProps {
  readonly value: DateTimeRange | undefined;
  readonly presets?: readonly DateTimeRangePreset[];
  readonly pattern?: string;
  readonly min?: Date;
  readonly max?: Date;
  readonly disabled?: boolean;
  readonly trigger?: React.ReactElement;
  readonly allowClear?: boolean;
  readonly onChange: (value: DateTimeRange | undefined) => void;
}

const DEFAULT_PATTERN = "yyyy-MM-dd HH:mm";

export const DateTimeRangePicker: React.FC<DateTimeRangePickerProps> = ({
  value,
  presets = [],
  pattern = DEFAULT_PATTERN,
  min,
  max,
  disabled,
  trigger,
  allowClear = false,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const locale = getLocale() === "zh-Hans" ? zhCN : enUS;
  const normalizedFrom = cloneValidDate(value?.from);
  const normalizedTo = cloneValidDate(value?.to);
  const normalizedValue =
    normalizedFrom === undefined || normalizedTo === undefined ? undefined : { from: normalizedFrom, to: normalizedTo };
  const minimum = cloneValidDate(min);
  const maximum = cloneValidDate(max);
  const draft = createDateTimeRangeDraft(normalizedValue, pattern, locale);
  const summary =
    draft.from && draft.to ? `${draft.from} – ${draft.to}` : m["dashboard.date_time_range_picker.title"]();
  const triggerElement = trigger ?? (
    <Button type="button" variant="outline" aria-label={m["dashboard.date_time_range_picker.title"]()} />
  );
  const triggerChildren =
    trigger === undefined ? (
      <>
        <CalendarIcon />
        {summary}
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
  const triggerWithClear =
    trigger === undefined ? (
      <span className="inline-flex items-center">
        {pickerTrigger}
        {allowClear && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={m["dashboard.date_time_range_picker.clear"]()}
            onClick={(event) => {
              event.stopPropagation();
              onChange(undefined);
            }}
          >
            <XIcon />
          </Button>
        )}
      </span>
    ) : (
      pickerTrigger
    );
  const panel = open && (
    <DateTimeRangePickerPanel
      value={normalizedValue}
      presets={presets}
      pattern={pattern}
      locale={locale}
      min={minimum}
      max={maximum}
      mobile={mobile}
      onApply={(next) => {
        onChange(next);
        setOpen(false);
      }}
    />
  );

  return mobile ? (
    <Sheet open={open} onOpenChange={setOpen}>
      {triggerWithClear}
      <SheetContent side="bottom" className="max-h-[90dvh] rounded-t-3xl p-0">
        <SheetTitle className="p-6 pr-16 pb-4">{m["dashboard.date_time_range_picker.title"]()}</SheetTitle>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">{panel}</div>
      </SheetContent>
    </Sheet>
  ) : (
    <Popover open={open} onOpenChange={setOpen}>
      {triggerWithClear}
      <PopoverContent className="w-auto" align="start">
        {panel}
      </PopoverContent>
    </Popover>
  );
};
