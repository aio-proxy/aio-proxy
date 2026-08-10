import { m } from '@aio-proxy/i18n';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import {
  Pagination as PaginationRoot,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@aio-proxy/ui/components/pagination';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';

interface PaginationProps {
  readonly pageSize: number;
  readonly pageSizeOptions?: readonly number[];
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onShowSizeChange: (pageSize: number) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

export const Pagination: React.FC<PaginationProps> = ({
  pageSize,
  pageSizeOptions = [10, 25, 50, 100],
  canPrevious,
  canNext,
  onShowSizeChange,
  onPrevious,
  onNext,
}) => {
  const form = useForm({ defaultValues: { pageSize } });
  const previousLabel = m['dashboard.pagination.previous']();
  const nextLabel = m['dashboard.pagination.next']();

  return (
    <div className="flex items-center justify-between gap-4">
      <Field orientation="horizontal" className="w-fit">
        <FieldLabel htmlFor="select-rows-per-page">{m['dashboard.pagination.page_size']()}</FieldLabel>
        <form.Field name="pageSize">
          {(field) => (
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                if (value === null) return;
                const nextPageSize = Number(value);
                field.handleChange(nextPageSize);
                onShowSizeChange(nextPageSize);
              }}
            >
              <SelectTrigger className="w-20" id="select-rows-per-page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  {pageSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </form.Field>
      </Field>
      <PaginationRoot className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              disabled={!canPrevious}
              text={previousLabel}
              aria-label={previousLabel}
              onClick={() => {
                if (canPrevious) onPrevious();
              }}
            />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              disabled={!canNext}
              text={nextLabel}
              aria-label={nextLabel}
              onClick={() => {
                if (canNext) onNext();
              }}
            />
          </PaginationItem>
        </PaginationContent>
      </PaginationRoot>
    </div>
  );
};
