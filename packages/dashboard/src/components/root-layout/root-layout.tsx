import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/query-client";

import { RootLayoutContent } from "./root-layout-content";

export const RootLayout: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableColorScheme={false} enableSystem storageKey="theme">
        <TooltipProvider>
          <RootLayoutContent />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};
