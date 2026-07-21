import { getLocale, m } from "@aio-proxy/i18n";
import { enUS, zhCN } from "date-fns/locale";
import { CalendarIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

import type {
  DateTimeInput,
  DateTimeRangePreset,
  DateTimeRangeValue,
  ResolvedDateTimeRangeValue,
} from "./date-time-range-picker.types";

import { createDateTimeRangeDraft } from "./date-time-range";
import { DateTimeRangePickerPanel } from "./date-time-range-picker-panel";
import { normalizeDateTimeInput } from "./date-time-range-value";

interface DateTimeRangePickerProps {
  readonly value: DateTimeRangeValue | undefined;
  readonly presets?: readonly DateTimeRangePreset[];
  readonly format?: string;
  readonly min?: DateTimeInput;
  readonly max?: DateTimeInput;
  readonly disabled?: boolean;
  readonly render?: React.ComponentProps<typeof PopoverTrigger>["render"];
  readonly allowClear?: boolean;
  readonly onChange: (value: ResolvedDateTimeRangeValue | undefined) => void;
}

const DEFAULT_PATTERN = "yyyy-MM-dd HH:mm";

export const DateTimeRangePicker: React.FC<DateTimeRangePickerProps> = ({
  value,
  presets = [],
  format = DEFAULT_PATTERN,
  min,
  max,
  disabled,
  render,
  allowClear = false,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const locale = getLocale() === "zh-Hans" ? zhCN : enUS;
  const normalizedFrom = normalizeDateTimeInput(value?.from);
  const normalizedTo = normalizeDateTimeInput(value?.to);
  const normalizedValue =
    normalizedFrom === undefined || normalizedTo === undefined ? undefined : { from: normalizedFrom, to: normalizedTo };
  const minimum = normalizeDateTimeInput(min);
  const maximum = normalizeDateTimeInput(max);
  const draft = createDateTimeRangeDraft(normalizedValue, format, locale);
  const summary =
    draft.from && draft.to ? `${draft.from} – ${draft.to}` : m["dashboard.date_time_range_picker.title"]();
  const triggerRender = render ?? (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      aria-label={m["dashboard.date_time_range_picker.title"]()}
    />
  );
  const triggerChildren =
    render === undefined ? (
      <>
        <CalendarIcon />
        {summary}
      </>
    ) : undefined;
  const trigger = mobile ? (
    <SheetTrigger render={triggerRender} disabled={render === undefined ? undefined : disabled}>
      {triggerChildren}
    </SheetTrigger>
  ) : (
    <PopoverTrigger render={triggerRender} disabled={render === undefined ? undefined : disabled}>
      {triggerChildren}
    </PopoverTrigger>
  );
  const triggerWithClear =
    render === undefined ? (
      <span className="inline-flex items-center">
        {trigger}
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
      trigger
    );
  const panel = open && (
    <DateTimeRangePickerPanel
      value={normalizedValue}
      presets={presets}
      pattern={format}
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
