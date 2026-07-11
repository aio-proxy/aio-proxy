import { QueryClientProvider } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { SideMenu } from "@/components/side-menu";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/query-client";

export const RootLayout: React.FC = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableColorScheme={false} enableSystem storageKey="theme">
        <TooltipProvider>
          <SidebarProvider>
            <SideMenu />
            <SidebarInset className="h-[calc(100dvh-1rem)]">
              <Outlet />
            </SidebarInset>
            <Toaster />
          </SidebarProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};
