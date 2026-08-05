import { Breadcrumbs, type BreadcrumbItem } from '@/components/breadcrumbs';

type BreadcrumbItems = readonly [BreadcrumbItem, ...BreadcrumbItem[]];

interface PageContainerProps {
  readonly title: string;
  readonly subtitle?: React.ReactNode;
  readonly extra?: React.ReactNode;
  readonly breadcrumbs: BreadcrumbItems;
}

export const PageContainer: React.FC<React.PropsWithChildren<PageContainerProps>> = ({
  title,
  subtitle,
  extra,
  breadcrumbs,
  children,
}) => {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <header className="container mx-auto flex min-h-16 flex-col items-start justify-between gap-3 px-4 pt-8 pb-4 sm:flex-row">
        <div className="flex min-w-0 items-start gap-1">
          <div className="min-w-0">
            <Breadcrumbs items={breadcrumbs} />
            <h1 className="truncate font-heading text-2xl font-semibold">{title}</h1>
            {subtitle === undefined ? null : <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
          </div>
        </div>
        {extra && <div className="w-full sm:ml-2 sm:w-auto">{extra}</div>}
      </header>
      <main className="container mx-auto p-3">{children}</main>
    </div>
  );
};
