import { useQuery } from '@tanstack/react-query';

import { routingModelsQueryOptions } from '../services/routing-service';

export const useRoutingQuery = () => useQuery(routingModelsQueryOptions());
