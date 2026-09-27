import { Toaster } from '@aio-proxy/ui/components/toast';

import { CodeEntry } from '../../components/code-entry';

export const AgentAuthorizationPage: React.FC = () => (
  <>
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <CodeEntry />
    </main>
    <Toaster />
  </>
);
