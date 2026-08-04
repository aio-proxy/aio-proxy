import { m } from '@aio-proxy/i18n';
import { buttonVariants } from '@aio-proxy/ui/components/button';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';

import { Breadcrumbs, type BreadcrumbItem } from '@/components/breadcrumbs';

interface PageContainerProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly extra?: React.ReactNode;
  readonly backTo?: React.ComponentProps<typeof Link>['to'];
  readonly breadcrumbs?: readonly BreadcrumbItem[];
}

export const PageContainer: React.FC<React.PropsWithChildren<PageContainerProps>> = ({
  title,
  subtitle,
  extra,
  backTo,
  breadcrumbs,
  children,
}) => {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <header className="container mx-auto flex min-h-16 flex-col items-start justify-between gap-3 px-4 pt-8 pb-4 sm:flex-row">
        <div className="flex min-w-0 items-start gap-1">
          {!!backTo && (
            <Link
              to={backTo}
              preload="intent"
              aria-label={m['dashboard.navigation.back']()}
              className={buttonVariants({ variant: 'ghost', size: 'icon-lg' })}
            >
              <ArrowLeftIcon />
            </Link>
          )}
          <div className="min-w-0">
            {breadcrumbs === undefined ? null : <Breadcrumbs items={breadcrumbs} />}
            <h1 className="truncate font-heading text-2xl font-semibold">{title}</h1>
            {subtitle === undefined ? null : <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {extra && <div className="w-full sm:ml-2 sm:w-auto">{extra}</div>}
      </header>
      <main className="container mx-auto p-3">{children}</main>
    </div>
  );
};
