import { useQuery } from '@tanstack/react-query';

import { agentClaudeCodePlanQueryOptions } from '../../services/agents-service';

/** Fetched on demand by the Configure click, so the key choices are the ones on file at that moment. */
export const useClaudeCodePlan = () => useQuery({ ...agentClaudeCodePlanQueryOptions(), enabled: false });
