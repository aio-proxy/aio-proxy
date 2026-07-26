import { m } from '@aio-proxy/i18n';
import { type Locale } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { DateTimeRange, DateTimeRangePreset } from './date-time-range-picker.types';
import { useDateTimeRangeDraft } from './use-date-time-range-draft';

interface DateTimeRangePickerPanelProps {
  value?: DateTimeRange;
  pattern: string;
  locale: Locale;
  min?: Date;
  max?: Date;
  presets: readonly DateTimeRangePreset[];
  mobile: boolean;
  onChange: (value: DateTimeRange) => void;
}

export const DateTimeRangePickerPanel: React.FC<DateTimeRangePickerPanelProps> = ({
  value,
  pattern,
  locale,
  min,
  max,
  presets,
  mobile,
  onChange,
}) => {
  const { draft, setDraft, validation, errors, selected, disabledDates, selectRange, selectPreset, endpoints } =
    useDateTimeRangeDraft({ value, pattern, locale, min, max, onChange });

  return (
    <div
      data-testid="date-time-range-panel"
      className={cn('grid', mobile ? 'w-full gap-4' : 'w-128 max-w-[calc(100vw-2rem)]')}
    >
      <div
        data-slot="date-time-range-primary"
        className={cn('grid gap-4', !mobile && 'grid-cols-[minmax(0,1fr)_11rem] border-b pb-4')}
      >
        <div className={cn('min-w-0', mobile && 'order-2')}>
          <Calendar
            data-testid="date-time-range-calendar"
            className={cn('p-0', mobile && 'w-full')}
            mode="range"
            numberOfMonths={1}
            excludeDisabled
            defaultMonth={selected?.from}
            selected={selected}
            disabled={disabledDates}
            locale={locale}
            onSelect={selectRange}
          />
        </div>
        {presets.length > 0 && (
          <div
            data-slot="date-time-range-presets"
            className={cn(
              'grid',
              mobile ? 'order-1 grid-cols-2 gap-2' : 'max-h-72 content-start gap-1 overflow-y-auto',
            )}
          >
            {presets.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant={mobile ? 'outline' : 'ghost'}
                className={mobile ? undefined : 'justify-start'}
                onClick={() => selectPreset(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div data-slot="date-time-range-fields" className={cn('grid gap-4', !mobile && 'grid-cols-2 border-b py-4')}>
        {endpoints.map((endpoint) => {
          const fieldErrors = errors.filter((error) => error.path[0] === endpoint.name);
          return (
            <Field key={endpoint.name} data-invalid={fieldErrors.length > 0}>
              <FieldLabel htmlFor={endpoint.id}>{endpoint.label}</FieldLabel>
              <Input
                id={endpoint.id}
                value={draft[endpoint.name]}
                aria-invalid={fieldErrors.length > 0}
                onChange={(event) => setDraft({ ...draft, [endpoint.name]: event.target.value })}
              />
              <FieldError errors={fieldErrors} />
            </Field>
          );
        })}
        <FieldError
          className={mobile ? undefined : 'col-span-full'}
          errors={errors.filter((error) => error.path.length === 0)}
        />
      </div>
      <div data-slot="date-time-range-actions" className={mobile ? 'bg-popover pt-2' : 'flex justify-end pt-4'}>
        <Button
          type="button"
          className={mobile ? 'w-full' : undefined}
          disabled={!validation.success}
          onClick={() => validation.success && onChange(validation.data)}
        >
          {m['dashboard.date_time_range_picker.apply']()}
        </Button>
      </div>
    </div>
  );
};
