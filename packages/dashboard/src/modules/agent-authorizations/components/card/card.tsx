import { AioProxyLogo } from '@aio-proxy/brand';
import { m } from '@aio-proxy/i18n';
import { Card as Surface, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';

interface CardProps extends React.ComponentProps<typeof Surface> {
  readonly description?: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({ description, children, className, ...props }) => {
  return (
    <div className="mx-auto flex min-h-dvh items-center md:max-w-sm lg:max-w-md">
      <Surface className={cn('mb-16 shadow-none ring-0', className)} {...props}>
        <CardHeader>
          <CardTitle>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              {m['dashboard.agent_authorization.title']()}
              <AioProxyLogo className="text-xl" />
            </h1>
          </CardTitle>
          {!!description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        {children}
      </Surface>
    </div>
  );
};
