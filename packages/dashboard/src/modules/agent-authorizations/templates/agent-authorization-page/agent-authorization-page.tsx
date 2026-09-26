import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Toaster } from '@aio-proxy/ui/components/toast';
import { useState } from 'react';

import { AgentAuthorizationCodeEntry } from '../../components/agent-authorization-code-entry';
import { AgentAuthorizationReview } from '../../components/agent-authorization-review';

type PendingAuthorization = Extract<AgentAuthorizationDetails, { status: 'pending' }>;

export const AgentAuthorizationPage: React.FC = () => {
  const [details, setDetails] = useState<PendingAuthorization>();
  return (
    <>
      <main className="min-h-dvh bg-card">
        {details === undefined ? (
          <AgentAuthorizationCodeEntry onResolved={setDetails} />
        ) : (
          <AgentAuthorizationReview details={details} />
        )}
      </main>
      <Toaster />
    </>
  );
};
