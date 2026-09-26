import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { useState } from 'react';

import { AgentAuthorizationCodeEntry } from '../../components/agent-authorization-code-entry';
import { AgentAuthorizationReview } from '../../components/agent-authorization-review';

export const AgentAuthorizationPage: React.FC = () => {
  const [details, setDetails] = useState<AgentAuthorizationDetails>();
  return (
    <main className="min-h-dvh bg-card">
      {details === undefined ? (
        <AgentAuthorizationCodeEntry onResolved={setDetails} />
      ) : (
        <AgentAuthorizationReview details={details} />
      )}
    </main>
  );
};
