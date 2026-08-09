import type { DashboardProviderSummary } from '@aio-proxy/types';
import { createContext, useContext } from 'react';

import type { DeleteProviderDialogRef } from './delete-provider-dialog';
import { ProviderMoreMenu } from './provider-more-menu';

interface ProviderTableActionsContextValue {
  readonly deleteDialogRef: React.RefObject<DeleteProviderDialogRef | null>;
}

interface ProviderTableActionsProps {
  readonly provider: DashboardProviderSummary;
}

export const ProviderTableActionsContext = createContext<ProviderTableActionsContextValue | null>(null);

export const ProviderTableActions: React.FC<ProviderTableActionsProps> = ({ provider }) => {
  const actions = useContext(ProviderTableActionsContext);
  if (actions === null) return null;

  return <ProviderMoreMenu provider={provider} onDelete={() => actions.deleteDialogRef.current?.open(provider)} />;
};
