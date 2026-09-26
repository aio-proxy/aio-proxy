import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { useState } from 'react';

import { AgentAuthorizationCodeEntry } from '../../components/agent-authorization-code-entry';
import { AgentAuthorizationReview } from '../../components/agent-authorization-review';

export const AgentAuthorizationPage: React.FC = () => {
  const [details, setDetails] = useState<AgentAuthorizationDetails>();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-4 py-8">
      {details === undefined ? (
        <AgentAuthorizationCodeEntry onResolved={setDetails} />
      ) : (
        <AgentAuthorizationReview details={details} onRetry={() => setDetails(undefined)} />
      )}
    </main>
  );
};
