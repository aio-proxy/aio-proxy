import type { ProviderProtocol } from '@aio-proxy/types';
import type React from 'react';

import { ProtocolLabel } from '@/components/protocol-label';

interface ProviderProtocolLabelsProps {
  readonly protocols: readonly ProviderProtocol[];
}

export const ProviderProtocolLabels: React.FC<ProviderProtocolLabelsProps> = ({ protocols }) => (
  <>
    {protocols.map((protocol, index) => (
      <span key={protocol}>
        {index === 0 ? null : <span aria-hidden="true">{', '}</span>}
        <ProtocolLabel protocol={protocol} />
      </span>
    ))}
  </>
);
