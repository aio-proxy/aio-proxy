import { m } from '@aio-proxy/i18n';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@aio-proxy/ui/components/pagination';

interface PaginationControlsProps {
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

export const PaginationControls: React.FC<PaginationControlsProps> = ({ canPrevious, canNext, onPrevious, onNext }) => {
  const previousLabel = m['dashboard.pagination.previous']();
  const nextLabel = m['dashboard.pagination.next']();

  return (
    <Pagination className="mx-0 w-auto justify-end">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            size="icon"
            text={previousLabel}
            aria-label={previousLabel}
            aria-disabled={!canPrevious || undefined}
            tabIndex={canPrevious ? undefined : -1}
            className="p-0! [&_span]:hidden"
            onClick={(event) => {
              event.preventDefault();
              if (canPrevious) onPrevious();
            }}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href="#"
            size="icon"
            text={nextLabel}
            aria-label={nextLabel}
            aria-disabled={!canNext || undefined}
            tabIndex={canNext ? undefined : -1}
            className="p-0! [&_span]:hidden"
            onClick={(event) => {
              event.preventDefault();
              if (canNext) onNext();
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
};
