import { useQuery } from '@tanstack/react-query';

import { settingsQueryOptions } from '../../services/settings-service';

export const useSettingsQuery = () => useQuery(settingsQueryOptions());
