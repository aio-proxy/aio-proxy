import { useQuery } from '@tanstack/react-query';

import { agentsSnapshotQueryOptions } from '../../services/agents-service';

export const useAgentsSnapshot = () => useQuery(agentsSnapshotQueryOptions());
