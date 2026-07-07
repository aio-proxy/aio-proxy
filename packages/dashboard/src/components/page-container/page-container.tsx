import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface PageContainerProps {
  readonly title: string;
  readonly extra?: React.ReactNode;
}

export const PageContainer: React.FC<React.PropsWithChildren<PageContainerProps>> = ({ title, extra, children }) => {
  return (
    <>
      <header className="flex justify-between items-center border-border border-b px-4 h-12">
        <div className="min-w-0 truncate ">
          <h1 className="text-sm/normal font-semibold inline">{title}</h1>
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
