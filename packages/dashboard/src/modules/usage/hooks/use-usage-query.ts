import { useQuery } from "@tanstack/react-query";

import { type UsageQueryInput, usageQueryOptions } from "../services/usage-service";

export const useUsageQuery = (input: UsageQueryInput) => useQuery(usageQueryOptions(input));
