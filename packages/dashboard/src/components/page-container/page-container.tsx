import { m } from "@aio-proxy/i18n";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface PageContainerProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly extra?: React.ReactNode;
  readonly backTo?: React.ComponentProps<typeof Link>["to"];
}

export const PageContainer: React.FC<React.PropsWithChildren<PageContainerProps>> = ({
  title,
  subtitle,
  extra,
  backTo,
  children,
}) => {
  return (
    <>
      <header className="flex h-16 items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-1">
          {!!backTo && (
            <Link
              to={backTo}
              preload="intent"
              aria-label={m["dashboard.navigation.back"]()}
              className={buttonVariants({ variant: "ghost", size: "icon" })}
            >
              <ArrowLeftIcon />
            </Link>
          )}
          <div className="min-w-0">
            <h1 className="truncate font-heading text-xl font-semibold">{title}</h1>
            {subtitle === undefined ? null : <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {extra && <div className="ml-2">{extra}</div>}
      </header>
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className="px-3 pb-3">{children}</div>
        <ScrollBar orientation="vertical" />
      </ScrollArea>
    </>
  );
};
