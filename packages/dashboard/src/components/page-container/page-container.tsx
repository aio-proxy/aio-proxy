import { cn } from '@aio-proxy/ui/lib/utils';

import { Breadcrumbs, type BreadcrumbItem } from '@/components/breadcrumbs';

type BreadcrumbItems = readonly [BreadcrumbItem, ...BreadcrumbItem[]];

interface PageContainerProps {
  readonly title: string;
  readonly subtitle?: React.ReactNode;
  readonly extra?: React.ReactNode;
  readonly breadcrumbs: BreadcrumbItems;
  readonly classNames?: {
    root?: string;
    header?: string;
    main?: string;
  };
}

export const PageContainer: React.FC<React.PropsWithChildren<PageContainerProps>> = ({
  title,
  subtitle,
  extra,
  breadcrumbs,
  classNames,
  children,
}) => {
  return (
    <div className={cn('h-full min-h-0 w-full flex-1 overflow-y-auto', classNames?.root)}>
      <header className={cn('container mx-auto px-4 pt-8 pb-4', classNames?.header)}>
        <div className="space-y-2">
          <Breadcrumbs items={breadcrumbs} />
          <div className="flex w-full items-start justify-between gap-1">
            <div className="min-w-0">
              <h1 className="truncate font-heading text-2xl font-semibold">{title}</h1>
              {subtitle === undefined ? null : <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
            </div>
            {extra && <div className="w-full sm:ml-2 sm:w-auto">{extra}</div>}
          </div>
        </div>
      </header>
      <main className={cn('container mx-auto p-3', classNames?.main)}>{children}</main>
    </div>
  );
};
