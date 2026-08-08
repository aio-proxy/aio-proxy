import { m } from '@aio-proxy/i18n';
import {
  Breadcrumb,
  BreadcrumbItem as BreadcrumbListItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@aio-proxy/ui/components/breadcrumb';
import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';

export interface BreadcrumbItem {
  readonly label: React.ReactNode;
  readonly to?: React.ComponentProps<typeof Link>['to'];
}

interface BreadcrumbsProps {
  readonly items: readonly BreadcrumbItem[];
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({ items }) => (
  <Breadcrumb aria-label={m['dashboard.navigation.breadcrumbs']()}>
    <BreadcrumbList>
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1;
        return (
          <Fragment key={`breadcrumb-${index}`}>
            <BreadcrumbListItem>
              {isCurrent && item.to === undefined ? (
                <BreadcrumbPage>{item.label}</BreadcrumbPage>
              ) : item.to === undefined ? (
                <span>{item.label}</span>
              ) : (
                <BreadcrumbLink render={<Link to={item.to} />}>{item.label}</BreadcrumbLink>
              )}
            </BreadcrumbListItem>
            {isCurrent ? null : <BreadcrumbSeparator />}
          </Fragment>
        );
      })}
    </BreadcrumbList>
  </Breadcrumb>
);
