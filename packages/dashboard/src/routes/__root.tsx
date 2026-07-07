import { getLocale } from "@aio-proxy/i18n";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { RootLayout } from "@/components/root-layout";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRoute({
  head: () => ({
    meta: [],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1>404</h1>
      <p>The requested page could not be found.</p>
    </main>
  ),
  shellComponent: ({ children }) => {
    return (
      <html lang={getLocale()}>
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Toaster />
          <Scripts />
        </body>
      </html>
    );
  },
  component: RootLayout,
});
