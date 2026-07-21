import { getLocale, m } from "@aio-proxy/i18n";
import { enUS, zhCN } from "date-fns/locale";
import { CalendarIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import type {
  DateTimeInput,
  DateTimeRangePreset,
  DateTimeRangeValue,
  ResolvedDateTimeRangeValue,
} from "./date-time-range-picker.types";

import { DateTimeRangePickerPanel } from "./date-time-range-picker-panel";
import { createDateTimeRangeDraft } from "./date-time-range-value";

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
  const locale = getLocale() === "zh-Hans" ? zhCN : enUS;
  const draft = createDateTimeRangeDraft(value, format, locale);
  const summary =
    draft.from && draft.to ? `${draft.from} – ${draft.to}` : m["dashboard.date_time_range_picker.title"]();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {render === undefined ? (
        <span className="inline-flex items-center">
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                aria-label={m["dashboard.date_time_range_picker.title"]()}
              />
            }
          >
            <CalendarIcon />
            {summary}
          </PopoverTrigger>
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
        <PopoverTrigger render={render} disabled={disabled} />
      )}
      <PopoverContent className="w-auto" align="start">
        {open && (
          <DateTimeRangePickerPanel
            value={value}
            presets={presets}
            pattern={format}
            min={min}
            max={max}
            mobile={false}
            onApply={(next) => {
              onChange(next);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
};
