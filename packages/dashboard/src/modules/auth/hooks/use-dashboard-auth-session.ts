import { useQuery } from "@tanstack/react-query";

import { dashboardAuthSessionQueryOptions } from "../services/auth-service";

export const useDashboardAuthSession = () => useQuery(dashboardAuthSessionQueryOptions());
