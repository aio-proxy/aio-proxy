import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface PageContainerProps {
  readonly title: string;
  readonly extra?: React.ReactNode;
  readonly backTo?: React.ComponentProps<typeof Link>["to"];
}

export const PageContainer: React.FC<React.PropsWithChildren<PageContainerProps>> = ({
  title,
  extra,
  backTo,
  children,
}) => {
  return (
    <>
      <header className="flex h-16 items-center justify-between border-border border-b px-4">
        <div className="flex min-w-0 items-center gap-1 truncate">
          {!!backTo && (
            <Button variant="ghost" size="icon" render={<Link to={backTo} preload="intent" />}>
              <ArrowLeftIcon />
            </Button>
          )}
          <h1 className="inline font-semibold text-sm/normal">{title}</h1>
        </div>
        {extra && <div className="ml-2">{extra}</div>}
      </header>
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className="p-3">{children}</div>
        <ScrollBar orientation="vertical" />
      </ScrollArea>
    </>
  );
};
