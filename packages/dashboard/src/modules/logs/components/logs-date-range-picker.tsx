import { getLocale, m } from "@aio-proxy/i18n";
import { format, startOfDay } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { LogDateRange } from "../log-date-range";

type Props = {
  readonly value: LogDateRange;
  readonly onChange: (value: LogDateRange) => void;
};

export const LogsDateRangePicker: React.FC<Props> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const locale = getLocale() === "zh-Hans" ? zhCN : enUS;
  const retentionStart = startOfDay(new Date(Date.now() - 45 * 86_400_000));
  const today = startOfDay(new Date());
  const label = value.to
    ? `${format(value.from ?? value.to, "PP", { locale })} – ${format(value.to, "PP", { locale })}`
    : value.from
      ? format(value.from, "PP", { locale })
      : m["dashboard.logs.range"]();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            aria-label={m["dashboard.logs.range"]()}
            className="w-full justify-start font-normal"
          />
        }
      >
        <CalendarIcon />
        {label}
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start">
        <Calendar
          mode="range"
          selected={value as DateRange}
          defaultMonth={value.from}
          numberOfMonths={2}
          locale={locale}
          disabled={[{ before: retentionStart }, { after: today }]}
          onSelect={(range) => {
            const next = range ?? {};
            onChange(next);
            if (next.from && next.to) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};
