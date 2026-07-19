import { queryOptions } from "@tanstack/react-query";

import { createDashboardClient } from "@/lib/dashboard-client";

const dashboardClient = createDashboardClient();

export const pluginsQueryOptions = () =>
  queryOptions({
    queryKey: ["plugins"],
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.plugins.$get();
      return response.json();
    },
  });
