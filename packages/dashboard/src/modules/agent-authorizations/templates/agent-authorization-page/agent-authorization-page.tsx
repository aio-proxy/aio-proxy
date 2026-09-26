import { Toaster } from '@aio-proxy/ui/components/toast';

import { CodeEntry } from '../../components/code-entry';

export const AgentAuthorizationPage: React.FC = () => (
  <>
    <main className="min-h-dvh bg-card">
      <CodeEntry />
    </main>
    <Toaster />
  </>
);
