import { useQuery } from '@tanstack/react-query';

import { agentCodexPlanQueryOptions } from '../../services/agents-service';

/** Loaded only while the Codex form is open, so the plan token reflects what the user sees. */
export const useCodexPlan = (enabled: boolean) => useQuery({ ...agentCodexPlanQueryOptions(), enabled });
