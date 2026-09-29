import { Input } from '@aio-proxy/ui/components/input';
import { useForm } from '@tanstack/react-form';
import type React from 'react';

interface DataTableControlsProps {
  readonly table: {
    readonly setGlobalFilter: (value: string) => void;
  };
  readonly filterLabel: string;
  readonly filterPlaceholder: string;
  readonly children?: React.ReactNode;
}

export const DataTableControls: React.FC<DataTableControlsProps> = ({
  table,
  filterLabel,
  filterPlaceholder,
  children,
}) => {
  const form = useForm({ defaultValues: { globalFilter: '' } });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <form.Field name="globalFilter">
        {(field) => (
          <Input
            className="w-full sm:w-64"
            aria-label={filterLabel}
            placeholder={filterPlaceholder}
            value={field.state.value}
            onChange={(event) => {
              field.handleChange(event.target.value);
              table.setGlobalFilter(event.target.value);
            }}
          />
        )}
      </form.Field>
      {children}
    </div>
  );
};
