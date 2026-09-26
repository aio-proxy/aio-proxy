import type { AgentAuthorizationDetails } from '@aio-proxy/types';
import { Toaster } from '@aio-proxy/ui/components/toast';
import { useState } from 'react';

import { CodeEntry } from '../../components/code-entry';
import { Review } from '../../components/review';

type PendingAuthorization = Extract<AgentAuthorizationDetails, { status: 'pending' }>;

export const AgentAuthorizationPage: React.FC = () => {
  const [details, setDetails] = useState<PendingAuthorization>();
  return (
    <>
      <main className="min-h-dvh bg-card">
        {details === undefined ? <CodeEntry onResolved={setDetails} /> : <Review details={details} />}
      </main>
      <Toaster />
    </>
  );
};
