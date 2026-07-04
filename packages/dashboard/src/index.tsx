import type { AppType } from "@aio-proxy/server";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { hc } from "hono/client";
import ReactDOM from "react-dom/client";
import { routeTree } from "./route-tree.gen";

const router = createRouter({
  routeTree,
  basepath: "/dashboard",
  defaultPreload: "intent",
  scrollRestoration: true,
});

const rootEl = document.getElementById("root");
if (rootEl) {
  const root = ReactDOM.createRoot(rootEl);
  root.render(<RouterProvider router={router} />);
}

export const createDashboardClient = (baseUrl: string) => hc<AppType>(baseUrl);
