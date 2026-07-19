import { createRootRoute } from "@tanstack/react-router";

import { RootLayout } from "@/components/root-layout";

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
  component: RootLayout,
});
