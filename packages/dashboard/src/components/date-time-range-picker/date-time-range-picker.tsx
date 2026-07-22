import { getLocale, m } from "@aio-proxy/i18n";
import { enUS, zhCN } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

import type { DateTimeRange, DateTimeRangePreset } from "./date-time-range-picker.types";

import { cloneValidDate, createDateTimeRangeDraft } from "./date-time-range";
import { DateTimeRangePickerPanel } from "./date-time-range-picker-panel";

export interface DateTimeRangePickerProps {
  value?: DateTimeRange;
  presets?: readonly DateTimeRangePreset[];
  pattern?: string;
  min?: Date;
  max?: Date;
  disabled?: boolean;
  trigger?: React.ReactElement;
  onChange: (value: DateTimeRange) => void;
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
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const locale = getLocale() === "zh-Hans" ? zhCN : enUS;
  const minimum = cloneValidDate(min);
  const maximum = cloneValidDate(max);
  const draft = createDateTimeRangeDraft(value, pattern, locale);
  const summary =
    draft.from && draft.to ? `${draft.from} – ${draft.to}` : m["dashboard.date_time_range_picker.title"]();
  const triggerElement = trigger ?? (
    <Button
      type="button"
      variant="outline"
      className="w-full justify-start overflow-hidden"
      aria-label={m["dashboard.date_time_range_picker.title"]()}
    />
  );
  const triggerChildren =
    trigger === undefined ? (
      <>
        <CalendarIcon className="shrink-0" />
        <span className="truncate">{summary}</span>
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
        <SheetTitle className="p-6 pr-16 pb-4">{m["dashboard.date_time_range_picker.title"]()}</SheetTitle>
        <div className="min-h-0 overflow-y-auto px-4 pb-4">{panel}</div>
      </SheetContent>
    </Sheet>
  ) : (
    <Popover open={open} onOpenChange={setOpen}>
      {pickerTrigger}
      <PopoverContent className="w-auto" align="start">
        {panel}
      </PopoverContent>
    </Popover>
  );
};
